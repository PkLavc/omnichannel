import { Prisma, type PrismaClient } from "@prisma/client";
import { upsertDocument } from "./importer.js";
import { toolAuthHeaders, type ToolAuth } from "./tools.js";
import type { EmbeddingOptions } from "../core/embedding.js";

export type CatalogSyncSource = {
  url: string;
  itemsPath: string;
  timeoutMs: number;
  auth?: ToolAuth;
};

export type CatalogSyncOutcome = {
  ok: boolean;
  itemCount: number;
  documentCount: number;
  error?: string;
};

type CatalogRow = Record<string, unknown>;

const ITEM_LIMIT = 5_000;
const ROWS_PER_DOCUMENT = 150;

function asText(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).replace(/[\u0000-\u001f]/g, " ").trim() : "";
}

function pathValue(value: unknown, path: string): unknown {
  if (!path.trim() || path.trim() === ".") return value;
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (["__proto__", "prototype", "constructor"].includes(key)) return undefined;
    if (current && typeof current === "object" && !Array.isArray(current)) return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

function field(row: CatalogRow, names: string[]) {
  for (const name of names) {
    const value = asText(row[name]);
    if (value) return value;
  }
  return "";
}

function catalogRows(value: unknown): CatalogRow[] {
  const list = Array.isArray(value) ? value : [];
  return list.filter((item): item is CatalogRow => Boolean(item) && typeof item === "object" && !Array.isArray(item)).slice(0, ITEM_LIMIT);
}

function catalogLine(row: CatalogRow) {
  const name = field(row, ["name", "nome", "title", "titulo", "produto", "descricao"]);
  if (!name) return "";
  const sku = field(row, ["sku", "codigo", "code", "id"]);
  const price = field(row, ["price", "preco", "valor", "salePrice", "precoVenda"]);
  const stock = field(row, ["stock", "estoque", "quantity", "quantidade", "saldo"]);
  const available = field(row, ["available", "disponivel", "active", "ativo"]);
  return [
    `Produto: ${name}`,
    sku && `Código: ${sku}`,
    price && `Preço atual: ${price}`,
    stock && `Estoque: ${stock}`,
    available && `Disponível: ${available}`,
  ].filter(Boolean).join(" | ");
}

function batches<T>(items: readonly T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

export function catalogSyncDue(lastRunAt: Date | null, intervalMinutes: number, now = new Date()) {
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt.getTime() >= intervalMinutes * 60_000;
}

export async function fetchCatalog(source: CatalogSyncSource, fetchImpl = globalThis.fetch) {
  const endpoint = new URL(source.url);
  if (endpoint.protocol !== "https:") throw new Error("A fonte do catálogo deve usar HTTPS");
  const host = endpoint.hostname.toLocaleLowerCase("en-US");
  if (host === "localhost" || host.endsWith(".local") || /^(?:127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/.test(host)) {
    throw new Error("A fonte do catálogo não pode apontar para rede local");
  }
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json", ...toolAuthHeaders(source.auth) },
    signal: AbortSignal.timeout(source.timeoutMs),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Fonte do catálogo respondeu HTTP ${response.status}`);
  const raw: unknown = await response.json();
  const rows = catalogRows(pathValue(raw, source.itemsPath));
  if (!rows.length) throw new Error("A fonte não retornou itens no caminho configurado");
  return rows;
}

export async function synchronizeCatalog(
  prisma: PrismaClient,
  config: { id: string; tenantId: string; sourceUrl: string | null; itemsPath: string; timeoutMs: number },
  auth: ToolAuth | undefined,
  embeddingOptions: EmbeddingOptions = {},
  fetchImpl = globalThis.fetch,
): Promise<CatalogSyncOutcome> {
  if (!config.sourceUrl) return { ok: false, itemCount: 0, documentCount: 0, error: "Fonte do catálogo não configurada" };
  try {
    const rows = await fetchCatalog({ url: config.sourceUrl, itemsPath: config.itemsPath, timeoutMs: config.timeoutMs, auth }, fetchImpl);
    const lines = rows.map(catalogLine).filter(Boolean);
    if (!lines.length) throw new Error("Nenhum item legível foi encontrado na fonte do catálogo");
    const parts = batches(lines, ROWS_PER_DOCUMENT);
    const now = new Date().toISOString();
    await prisma.knowledgeDocument.deleteMany({
      where: { tenantId: config.tenantId, source: "catalog-sync", externalId: { startsWith: `${config.id}::` } },
    });
    for (const [index, part] of parts.entries()) {
      await upsertDocument(
        prisma,
        config.tenantId,
        "catalog-sync",
        `${config.id}::${String(index + 1).padStart(4, "0")}`,
        `Catálogo sincronizado (${index + 1}/${parts.length})`,
        `Catálogo confirmado em ${now}. Use estes valores somente como referência atual; em caso de dúvida, informe que confirmará a disponibilidade.\n\n${part.join("\n")}`,
        { parentExternalId: config.id, kind: "catalog", synchronizedAt: now },
        undefined,
        embeddingOptions,
      );
    }
    await prisma.catalogSyncConfig.update({ where: { id: config.id }, data: { lastRunAt: new Date(), lastSuccessAt: new Date(), lastError: null } });
    return { ok: true, itemCount: lines.length, documentCount: parts.length };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Falha ao sincronizar catálogo";
    await prisma.catalogSyncConfig.update({ where: { id: config.id }, data: { lastRunAt: new Date(), lastError: message } });
    return { ok: false, itemCount: 0, documentCount: 0, error: message };
  }
}

export async function runDueCatalogSyncs(
  prisma: PrismaClient,
  decodeAuth: (value: string | null) => ToolAuth | undefined,
  embeddingForTenant: (settings: unknown) => EmbeddingOptions,
  now = new Date(),
) {
  const configs = await prisma.catalogSyncConfig.findMany({ where: { enabled: true, sourceUrl: { not: null } }, include: { tenant: { select: { settings: true } } } });
  const outcomes: CatalogSyncOutcome[] = [];
  for (const config of configs) {
    if (!catalogSyncDue(config.lastRunAt, config.intervalMinutes, now)) continue;
    outcomes.push(await synchronizeCatalog(prisma, config, decodeAuth(config.encryptedAuth), embeddingForTenant(config.tenant.settings)));
  }
  return { due: outcomes.length, succeeded: outcomes.filter(item => item.ok).length, failed: outcomes.filter(item => !item.ok).length };
}
