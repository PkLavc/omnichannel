import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import readXlsxFile from "read-excel-file/node";
import mammoth from "mammoth";
import pdf from "pdf-parse";
import { Prisma, type PrismaClient } from "@prisma/client";
import { embed, embedMany, vectorLiteral, type EmbeddingOptions } from "../core/embedding.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CHUNK_EXTERNAL_ID_SEPARATOR = ":chunk:";

export type ChunkOptions = {
  maxCharacters?: number;
  overlapCharacters?: number;
  minimumCharacters?: number;
};

type ChunkSource = {
  externalId: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
};

type KnowledgeDatabase = PrismaClient | Prisma.TransactionClient;

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeExtractedText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    nbsp: " ",
    quot: '"',
    raquo: "»",
    rdquo: "”",
    rsquo: "’",
  };

  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, code: string) => {
    if (code.startsWith("#")) {
      const numeric = code.startsWith("#x")
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

export function htmlToText(html: string) {
  return normalizeExtractedText(
    decodeHtmlEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
        .replace(/<\/(?:address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tr|ul)>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

export function markdownToText(markdown: string) {
  const withoutFrontMatter = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
  return normalizeExtractedText(
    htmlToText(
      withoutFrontMatter
        .replace(/```[^\n]*\n?/g, "")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s{0,3}>\s?/gm, "")
        .replace(/^\s*[-*_]{3,}\s*$/gm, "\n")
        .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/(^|[^\\])[*_~]{1,2}([^\n]*?)[*_~]{1,2}/g, "$1$2"),
    ),
  );
}

function splitOversizedSegment(segment: string, maxCharacters: number) {
  if (segment.length <= maxCharacters) return [segment];
  const sentences = segment.split(/(?<=[.!?;:])\s+(?=[\p{L}\p{N}])/u);
  const pieces: string[] = [];

  for (const sentence of sentences) {
    let remaining = sentence.trim();
    while (remaining.length > maxCharacters) {
      let boundary = remaining.lastIndexOf(" ", maxCharacters);
      if (boundary < Math.floor(maxCharacters * 0.6)) boundary = maxCharacters;
      pieces.push(remaining.slice(0, boundary).trim());
      remaining = remaining.slice(boundary).trim();
    }
    if (remaining) pieces.push(remaining);
  }
  return pieces;
}

/** Splits extracted content on semantic boundaries, with bounded overlap. */
export function chunkText(content: string, options: ChunkOptions = {}) {
  const maxCharacters = Math.max(300, Math.floor(options.maxCharacters ?? 1_800));
  const overlapCharacters = Math.max(
    0,
    Math.min(Math.floor(options.overlapCharacters ?? 220), Math.floor(maxCharacters / 3)),
  );
  const minimumCharacters = Math.max(1, Math.min(Math.floor(options.minimumCharacters ?? 80), maxCharacters));
  const normalized = normalizeExtractedText(content);
  if (!normalized) return [];

  const segments = normalized
    .split(/\n{2,}/)
    .flatMap((paragraph) => splitOversizedSegment(paragraph.trim(), maxCharacters))
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const segment of segments) {
    const candidate = current ? `${current}\n\n${segment}` : segment;
    if (candidate.length <= maxCharacters) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);
    const previousTail = overlapCharacters
      ? (current.slice(-overlapCharacters).match(/(?:^|\s)(\S[\s\S]*)$/)?.[1] ?? "").trim()
      : "";
    current = previousTail && previousTail.length + segment.length + 2 <= maxCharacters
      ? `${previousTail}\n\n${segment}`
      : segment;
  }
  if (current) chunks.push(current);

  if (chunks.length > 1 && chunks[chunks.length - 1].length < minimumCharacters) {
    const tail = chunks.pop()!;
    const previous = chunks.pop()!;
    const merged = `${previous}\n\n${tail}`;
    if (merged.length <= maxCharacters) chunks.push(merged);
    else chunks.push(previous, tail);
  }
  return chunks;
}

export async function extract(file: string) {
  const fileStat = await stat(file);
  if (!fileStat.isFile()) throw new Error(`O caminho não é um arquivo: ${file}`);
  if (fileStat.size === 0) throw new Error(`O arquivo está vazio: ${file}`);
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`O arquivo excede o limite de ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  }

  const extension = extname(file).toLowerCase();
  let text: string;
  if (extension === ".txt") text = await readFile(file, "utf8");
  else if (extension === ".md" || extension === ".markdown") text = markdownToText(await readFile(file, "utf8"));
  else if (extension === ".html" || extension === ".htm") text = htmlToText(await readFile(file, "utf8"));
  else if (extension === ".docx") text = (await mammoth.extractRawText({ path: file })).value;
  else if (extension === ".pdf") text = (await pdf(await readFile(file))).text;
  else throw new Error(`Formato não suportado: ${extension || "sem extensão"}`);

  const normalized = normalizeExtractedText(text);
  if (!normalized) throw new Error(`Nenhum texto legível foi extraído de ${basename(file)}`);
  return normalized;
}

export async function upsertDocument(
  prisma: KnowledgeDatabase,
  tenantId: string,
  source: string,
  externalId: string,
  title: string,
  content: string,
  metadata: Record<string, unknown> = {},
  embedding?: number[],
  embeddingOptions: EmbeddingOptions = {},
) {
  const cleanContent = normalizeExtractedText(content);
  if (!cleanContent) throw new Error("Não é possível indexar um documento vazio");
  const checksum = sha256(cleanContent);
  const doc = await prisma.knowledgeDocument.upsert({
    where: { tenantId_source_externalId: { tenantId, source, externalId } },
    update: { title, content: cleanContent, checksum, metadata: metadata as Prisma.InputJsonObject },
    create: {
      tenantId,
      source,
      externalId,
      title,
      content: cleanContent,
      checksum,
      metadata: metadata as Prisma.InputJsonObject,
    },
  });
  const vector = vectorLiteral(embedding ?? (await embed(cleanContent, embeddingOptions)));
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "KnowledgeDocument"
    SET embedding = ${vector}::vector
    WHERE id = ${doc.id}
  `);
  return doc;
}

async function persistChunkedSources(
  prisma: PrismaClient,
  tenantId: string,
  source: string,
  sources: ChunkSource[],
  removeMissing: boolean,
  embeddingOptions: EmbeddingOptions = {},
) {
  const prepared = sources.flatMap((item) => {
    const chunks = chunkText(item.content);
    return chunks.map((content, index) => ({
      ...item,
      content,
      externalId: `${item.externalId}${CHUNK_EXTERNAL_ID_SEPARATOR}${String(index + 1).padStart(4, "0")}`,
      metadata: {
        ...item.metadata,
        parentExternalId: item.externalId,
        chunkIndex: index,
        chunkCount: chunks.length,
      },
    }));
  });
  if (prepared.length === 0) throw new Error("Nenhum conteúdo legível foi encontrado para indexação");

  const vectors = await embedMany(prepared.map((item) => item.content), embeddingOptions);
  const currentIds = prepared.map((item) => item.externalId);

  return prisma.$transaction(async (transaction) => {
    if (removeMissing) {
      await transaction.knowledgeDocument.deleteMany({
        where: { tenantId, source, externalId: { notIn: currentIds } },
      });
    } else {
      const parentIds = sources.map((item) => item.externalId);
      await transaction.knowledgeDocument.deleteMany({
        where: {
          tenantId,
          source,
          OR: parentIds.flatMap((externalId) => [
            { externalId },
            { externalId: { startsWith: `${externalId}${CHUNK_EXTERNAL_ID_SEPARATOR}` } },
          ]),
        },
      });
    }

    const documents = [];
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index];
      documents.push(
        await upsertDocument(
          transaction,
          tenantId,
          source,
          item.externalId,
          item.title,
          item.content,
          item.metadata,
          vectors[index],
          embeddingOptions,
        ),
      );
    }
    return documents;
  });
}

export async function importFile(
  prisma: PrismaClient,
  tenantId: string,
  file: string,
  originalFilename = basename(file),
  embeddingOptions: EmbeddingOptions = {},
  metadata: Record<string, unknown> = {},
) {
  const absolutePath = resolve(file);
  const fileStat = await stat(absolutePath);
  const content = await extract(absolutePath);
  const extension = extname(absolutePath).toLowerCase();
  const safeFilename = basename(originalFilename).normalize("NFKC");
  const externalId = sha256(safeFilename.toLocaleLowerCase("pt-BR"));
  return persistChunkedSources(
    prisma,
    tenantId,
    "upload",
    [
      {
        externalId,
        title: safeFilename,
        content,
        metadata: {
          ...metadata,
          filename: safeFilename,
          extension,
          sizeBytes: fileStat.size,
        },
      },
    ],
    false,
    embeddingOptions,
  );
}

function field(row: Record<string, unknown>, names: string[]) {
  const entry = Object.entries(row).find(([key]) => names.includes(key.trim().toLocaleLowerCase("pt-BR")));
  return entry ? String(entry[1]).trim() : "";
}

function excelCellText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if ("result" in value && value.result !== undefined && value.result !== null) return String(value.result);
  if ("text" in value) return String(value.text);
  return "";
}

function worksheetRows(values: unknown[][]) {
  if (values.length < 2) return [];
  const headerRow = values[0];
  const columnCount = Math.max(...values.map((row) => row.length));
  if (columnCount < 1) return [];
  const usedHeaders = new Map<string, number>();
  const headers = Array.from({ length: columnCount }, (_, index) => {
    const base = excelCellText(headerRow[index]).normalize("NFKC").trim() || `Coluna ${index + 1}`;
    const occurrence = (usedHeaders.get(base) ?? 0) + 1;
    usedHeaders.set(base, occurrence);
    return occurrence === 1 ? base : `${base}_${occurrence}`;
  });
  const rows: Record<string, unknown>[] = [];
  for (const row of values.slice(1)) {
    const record = Object.create(null) as Record<string, unknown>;
    let hasValue = false;
    headers.forEach((header, index) => {
      const value = excelCellText(row[index]);
      record[header] = value;
      if (value.trim()) hasValue = true;
    });
    if (hasValue) rows.push(record);
  }
  return rows;
}

export async function importQuickReplies(
  prisma: PrismaClient,
  tenantId: string,
  file: string,
  company?: string,
  embeddingOptions: EmbeddingOptions = {},
  originalFilename = basename(file),
) {
  const fileStat = await stat(file);
  if (!fileStat.isFile()) throw new Error(`O caminho não é um arquivo: ${file}`);
  if (fileStat.size === 0) throw new Error(`O arquivo está vazio: ${file}`);
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`O arquivo excede o limite de ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  }
  const normalizedCompany = company?.trim().toLocaleLowerCase("pt-BR");
  const sources: ChunkSource[] = [];

  for (const sheet of await readXlsxFile(file)) {
    const sheetName = sheet.sheet;
    const rows = worksheetRows(sheet.data);
    const duplicateNames = new Map<string, number>();

    for (const row of rows) {
      const franchise = field(row, ["franquia", "empresa", "company"]);
      if (normalizedCompany && franchise.toLocaleLowerCase("pt-BR") !== normalizedCompany) continue;
      const values = Object.entries(row)
        .map(([key, value]) => ({ key: key.trim(), value: String(value ?? "").normalize("NFKC").trim() }))
        .filter((entry) => entry.value);
      const title = field(row, ["nome", "título", "titulo", "name", "title"])
        || values[0]?.value.slice(0, 200)
        || `Linha ${sources.length + 1}`;
      const knownMessage = field(row, ["mensagem", "resposta", "conteúdo", "conteudo", "message", "answer", "text"]);
      const message = knownMessage || values
        .filter((entry) => !["franquia", "empresa", "company", "nome", "título", "titulo", "name", "title"].includes(entry.key.toLocaleLowerCase("pt-BR")))
        .map((entry) => `${entry.key}: ${entry.value}`)
        .join("\n");
      if (!message) continue;

      const identity = `${sheetName}\u0000${title || "resposta rápida"}`.toLocaleLowerCase("pt-BR");
      const occurrence = (duplicateNames.get(identity) ?? 0) + 1;
      duplicateNames.set(identity, occurrence);
      sources.push({
        externalId: sha256(`${franchise.toLocaleLowerCase("pt-BR")}\u0000${identity}\u0000${occurrence}`),
        title: title || "Resposta rápida",
        content: title ? `${title}\n\n${message}` : message,
        metadata: { ...row, sheet: sheetName, company: franchise },
      });
    }
  }

  if (sources.length === 0) {
    throw new Error(company ? `Nenhuma resposta rápida da empresa ${company} foi encontrada` : "Nenhuma resposta rápida foi encontrada na planilha");
  }
  const source = basename(originalFilename).normalize("NFKC");
  await persistChunkedSources(prisma, tenantId, source, sources, true, embeddingOptions);
  return sources.length;
}
