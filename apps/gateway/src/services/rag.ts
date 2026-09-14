import { Prisma, type PrismaClient } from "@prisma/client";
import { embed, vectorLiteral, type EmbeddingOptions } from "../core/embedding.js";
import {
  readCorpusVersion,
  readSemanticRagCache,
  writeSemanticRagCache,
} from "./rag-cache.js";
import { rerankDocuments } from "./rag-reranker.js";
import { sanitizeUntrustedText } from "./prompt-security.js";

export type RetrievedDocument = {
  title: string;
  content: string;
  score: number;
};

export type RagRetrievalTrace = {
  cacheHit?: boolean;
  corpusVersion?: string;
};

export type RagAgentRole = "intake" | "sales" | "customer_care" | "technical" | "quality";

type RawRetrievedDocument = Omit<RetrievedDocument, "score"> & {
  score: number | string;
};

export class RagRetrievalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RagRetrievalError";
  }
}

/** Removes control payloads before database content is placed in an LLM prompt. */
export function sanitizeKnowledgeText(value: string, maxLength = 12_000) {
  return sanitizeUntrustedText(value, maxLength);
}

function positiveInteger(value: number, fallback: number, maximum: number) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function lexicalSearchTerms(query: string) {
  const ignored = new Set([
    "como", "da", "das", "de", "do", "dos", "esta", "estao", "para",
    "por", "qual", "quais", "que", "sao", "uma", "voce",
  ]);
  const tokens = query
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(tokens
    .map((token) => token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token)
    .filter((token) => !ignored.has(token)))]
    .slice(0, 12);
}

function similarityThreshold(value: number) {
  if (!Number.isFinite(value)) return 0.25;
  return Math.max(-1, Math.min(1, value));
}

function rerankCandidateLimit(limit: number) {
  const configuredMultiplier = Number(process.env.RAG_RERANK_CANDIDATE_MULTIPLIER ?? 4);
  const multiplier = Number.isInteger(configuredMultiplier)
    ? Math.max(1, Math.min(10, configuredMultiplier))
    : 4;
  return Math.min(80, Math.max(limit, limit * multiplier));
}

/**
 * Retrieves tenant-isolated knowledge by cosine similarity.
 *
 * SQL values are parameterized with Prisma.sql. Database and embedding errors
 * are deliberately propagated as RagRetrievalError; returning unrelated text
 * would make an unavailable vector store indistinguishable from a valid hit.
 */
export async function retrieve(
  prisma: PrismaClient,
  tenantId: string,
  query: string,
  limit = 5,
  minimumScore = Number(process.env.RAG_MIN_SCORE ?? 0.25),
  embeddingOptions: EmbeddingOptions = {},
  trace?: RagRetrievalTrace,
  agentRole?: RagAgentRole,
): Promise<RetrievedDocument[]> {
  if (trace) {
    trace.cacheHit = false;
    delete trace.corpusVersion;
  }
  const cleanTenantId = tenantId.trim();
  const cleanQuery = query.normalize("NFKC").trim();
  if (!cleanTenantId) throw new RagRetrievalError("Tenant é obrigatório para consultar o RAG");
  if (!cleanQuery) return [];

  const safeLimit = positiveInteger(limit, 5, 30);
  const safeMinimumScore = similarityThreshold(minimumScore);

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embed(cleanQuery, embeddingOptions);
  } catch (error) {
    throw new RagRetrievalError("Falha ao gerar o embedding da consulta", { cause: error });
  }
  const vector = vectorLiteral(queryEmbedding);
  const corpusVersion = await readCorpusVersion(prisma, cleanTenantId, embeddingOptions);
  if (trace && corpusVersion) trace.corpusVersion = corpusVersion;
  // Role-scoped corpora must never reuse a cache entry created for another
  // specialist. Shared documents remain eligible for every role below.
  if (corpusVersion && !agentRole) {
    const cached = await readSemanticRagCache(prisma, {
      tenantId: cleanTenantId,
      corpusVersion,
      query: cleanQuery,
      vector: queryEmbedding,
      limit: safeLimit,
      minimumScore: safeMinimumScore,
    });
    if (cached) {
      if (trace) trace.cacheHit = true;
      return rerankDocuments(cleanQuery, cached, safeLimit);
    }
  }

  let rows: RawRetrievedDocument[];
  const candidateLimit = rerankCandidateLimit(safeLimit);
  try {
    rows = await prisma.$queryRaw<RawRetrievedDocument[]>(Prisma.sql`
      SELECT
        title,
        content,
        1 - (embedding <=> ${vector}::vector) AS score
      FROM "KnowledgeDocument"
      WHERE "tenantId" = ${cleanTenantId}
        ${agentRole ? Prisma.sql`AND (metadata->>'agentRole' IS NULL OR metadata->>'agentRole' = ${agentRole})` : Prisma.empty}
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> ${vector}::vector) >= ${safeMinimumScore}
      ORDER BY embedding <=> ${vector}::vector, title, content
      LIMIT ${candidateLimit}
    `);
  } catch (error) {
    throw new RagRetrievalError("Falha na busca vetorial do RAG", { cause: error });
  }

  const semanticCandidates = rows
    .map((row) => ({
      title: sanitizeKnowledgeText(row.title, 300),
      content: sanitizeKnowledgeText(row.content),
      score: Number(row.score),
    }))
    .filter((row) => row.title.length > 0 && row.content.length > 0 && Number.isFinite(row.score));
  const candidates = [...semanticCandidates];
  if (candidates.length < safeLimit) {
    const terms = lexicalSearchTerms(cleanQuery);
    if (terms.length) {
      try {
        const clauses = terms.map((term) => {
          const pattern = `%${term}%`;
          return Prisma.sql`title ILIKE ${pattern} OR content ILIKE ${pattern}`;
        });
        const titleClauses = terms.map((term) =>
          Prisma.sql`title ILIKE ${`%${term}%`}`,
        );
        const lexicalRows = await prisma.$queryRaw<RawRetrievedDocument[]>(Prisma.sql`
          SELECT title, content, 0::double precision AS score
          FROM "KnowledgeDocument"
          WHERE "tenantId" = ${cleanTenantId}
            ${agentRole ? Prisma.sql`AND (metadata->>'agentRole' IS NULL OR metadata->>'agentRole' = ${agentRole})` : Prisma.empty}
            AND (${Prisma.join(clauses, " OR ")})
          ORDER BY
            CASE WHEN (${Prisma.join(titleClauses, " OR ")}) THEN 0 ELSE 1 END,
            title,
            content
          LIMIT ${candidateLimit}
        `);
        const seen = new Set(candidates.map((row) => `${row.title}\u0000${row.content}`));
        for (const row of lexicalRows) {
          const candidate = {
            title: sanitizeKnowledgeText(row.title, 300),
            content: sanitizeKnowledgeText(row.content),
            score: Number(row.score),
          };
          const key = `${candidate.title}\u0000${candidate.content}`;
          if (candidate.title && candidate.content && !seen.has(key)) {
            seen.add(key);
            candidates.push(candidate);
          }
        }
      } catch (error) {
        throw new RagRetrievalError("Falha na busca lexical do RAG", { cause: error });
      }
    }
  }
  if (corpusVersion && !agentRole) {
    await writeSemanticRagCache(prisma, {
      tenantId: cleanTenantId,
      corpusVersion,
      query: cleanQuery,
      vector: queryEmbedding,
      limit: safeLimit,
      minimumScore: safeMinimumScore,
      documents: candidates,
    });
  }
  return rerankDocuments(cleanQuery, candidates, safeLimit);
}
