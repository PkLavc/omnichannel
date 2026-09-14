import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  AdminAuthSource,
  AdminRole,
  CommercialOutcomeStatus,
  CommerceLinkKind,
  CommerceVerificationStatus,
  HumanFeedbackVerdict,
  LearningAgentRole,
  LearningReviewDecision,
  Prisma,
  PrismaClient,
  ProviderScope,
} from "@prisma/client";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { decrypt, encrypt } from "./core/crypto.js";
import type { AiProvider, CompletionResult, RoutedCompletionResult } from "./domain/provider.js";
import { ProviderRouter, withCompletionDefaults } from "./domain/provider.js";
import { OllamaProvider } from "./infrastructure/ollama-provider.js";
import { providerFrom } from "./infrastructure/providers.js";
import {
  automationSuppressed,
  businessRulesFromDocument,
  detectConversationSector,
  inBusinessHours,
  transferRequested,
  type ConversationSector,
} from "./services/business-flow.js";
import { ChatwootClient, type ChatwootAssignment, type ChatwootConfig } from "./services/chatwoot.js";
import { importFile, importQuickReplies } from "./services/importer.js";
import { runDueCatalogSyncs, synchronizeCatalog } from "./services/catalog-sync.js";
import { deterministicSummary, extractConversationState, type ConversationState } from "./services/memory.js";
import { proactiveIntakeAnswer } from "./services/intake.js";
import { LearningCandidateService } from "./services/learning-candidates.js";
import {
  ContinuousImprovementError,
  ContinuousImprovementService,
  continuousImprovementConstants,
} from "./services/continuous-improvement.js";
import { applyPromptBundle, parsePromptBundle, serializePromptBundle } from "./services/prompt-runtime.js";
import {
  AdminAuthError,
  AdminAuthService,
  adminCapabilities,
  hashAdminPassword,
  type AdminCapability,
  type AdminPrincipal,
  requireAdminCapability,
  requireTenantAuthorization,
} from "./services/admin-auth.js";
import { NexusSsoError, NexusSsoRedeemer } from "./services/nexus-sso.js";
import {
  ProviderAccessError,
  ProviderAccessService,
  requireProviderWriteAuthorization,
} from "./services/provider-access.js";
import { retrieve, type RagRetrievalTrace } from "./services/rag.js";
import { deleteRagDocument, getRagDocument, listRagDocuments, reindexRagDocuments, updateRagDocument } from "./services/rag-admin.js";
import { tenantGuardrails } from "./services/assistant-instructions.js";
import {
  assessGroundedResponse,
  assessPromptInjection,
  safeGroundingFallback,
  sanitizeUntrustedText,
  untrustedDataEnvelope,
  type GroundingEvidence,
} from "./services/prompt-security.js";
import { buildSpecializedAgentPrompt, routeSpecializedAgent } from "./services/specialized-agents.js";
import { buildInitialTenantSettings, embeddingOptionsFromSettings, mergeTenantSettings, promptSettings, safeTenantSettings } from "./services/tenant-settings.js";
import { createHttpToolAdapter, runConfiguredTools, testHttpTool, toolDefinitions, type ToolAuth } from "./services/tools.js";

const prisma = new PrismaClient();
const continuousImprovement = new ContinuousImprovementService(prisma);
const learningCandidates = new LearningCandidateService(prisma);
const providerAccess = new ProviderAccessService(prisma);
const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
await app.register(cors, {
  origin: [
    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/,
    /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/,
    ...String(process.env.ADMIN_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean),
  ],
});
await app.register(multipart, { limits: { files: 1, fileSize: 25 * 1024 * 1024 } });

const quickRepliesPath = process.env.QUICK_REPLIES_PATH ?? "/data/rag/respostas_rapidas.xlsx";
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken || adminToken.length < 16) throw new Error("ADMIN_TOKEN deve possuir pelo menos 16 caracteres");
const commercialEventsToken = process.env.COMMERCIAL_EVENTS_TOKEN;
const adminAuth = new AdminAuthService(prisma, {
  sessionSecret: createHash("sha256")
    .update(process.env.ENCRYPTION_KEY ?? adminToken)
    .digest(),
});
const nexusSso = process.env.NEXUS_SSO_REDEEM_URL
  ? new NexusSsoRedeemer({
      redeemUrl: process.env.NEXUS_SSO_REDEEM_URL,
      timeoutMs: Number(process.env.NEXUS_SSO_REDEEM_TIMEOUT_MS ?? "5000"),
    })
  : undefined;
const requestContext = new AsyncLocalStorage<FastifyRequest>();
const requestPrincipals = new WeakMap<FastifyRequest, AdminPrincipal>();

const providerOptionsSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().max(32_000).default(600),
  inputCostPerMillion: z.number().nonnegative().default(0),
  outputCostPerMillion: z.number().nonnegative().default(0),
  timeoutMs: z.number().int().min(100).max(300_000).default(45_000),
  healthPath: z.string().min(1).max(300).default("models"),
});
const providerSchema = z.object({
  type: z.enum(["cloudflare", "openrouter", "gemini", "ollama", "openai-compatible"]),
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(1_000),
  model: z.string().min(1).max(200),
  baseUrl: z.string().url().optional().nullable(),
  apiKey: z.string().min(1).nullable().optional(),
  scope: z.nativeEnum(ProviderScope).optional(),
  scopeMode: z.nativeEnum(ProviderScope).optional(),
  tenantIds: z.array(z.string().trim().min(1)).max(500).default([]),
  options: providerOptionsSchema.default({ temperature: 0.2, maxTokens: 600, inputCostPerMillion: 0, outputCostPerMillion: 0, timeoutMs: 45_000, healthPath: "models" }),
});
const businessHoursSchema = z.object({
  timezone: z.string().min(1),
  schedule: z.record(z.string(), z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)])),
});
const chatwootSectorRouteSchema = z.object({
  sector: z.enum(["commercial", "support", "postSale"]),
  teamId: z.number().int().positive(),
  assigneeId: z.number().int().positive().nullable().optional(),
});
const settingsSchema = z.object({
  companyName: z.string().trim().min(1).max(160).nullable().optional(),
  botName: z.string().trim().min(1).max(100).nullable().optional(),
  logo: z.string().max(2_000_000).nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  timezone: z.string().min(1).max(100).nullable().optional(),
  welcomeMessage: z.string().max(4_000).nullable().optional(),
  outOfHoursMessage: z.string().max(4_000).nullable().optional(),
  transferMessage: z.string().max(4_000).nullable().optional(),
  language: z.string().min(2).max(35).nullable().optional(),
  businessRulesEnabled: z.boolean().optional(),
  businessRulesDocument: z.unknown().optional(),
  prompts: z.object({
    system: z.string().max(30_000).nullable().optional(),
    commercial: z.string().max(20_000).nullable().optional(),
    support: z.string().max(20_000).nullable().optional(),
    postSale: z.string().max(20_000).nullable().optional(),
  }).partial().optional(),
  embeddings: z.object({
    provider: z.enum(["local", "ollama"]),
    baseUrl: z.string().url().nullable().optional(),
    model: z.string().min(1).max(200).nullable().optional(),
    timeoutMs: z.number().int().min(100).max(300_000).optional(),
  }).partial().optional(),
  chatwootUrl: z.string().url().nullable().optional(),
  chatwootAccountId: z.string().min(1).nullable().optional(),
  chatwootInboxId: z.string().min(1).nullable().optional(),
  chatwootInboxIds: z.array(z.string().trim().min(1)).max(100).optional(),
  chatwootWebhookUrl: z.string().url().nullable().optional(),
  chatwootApiToken: z.string().min(1).nullable().optional(),
  webhookSecret: z.string().min(8).nullable().optional(),
  chatwootTeamId: z.number().int().positive().nullable().optional(),
  chatwootAssigneeId: z.number().int().positive().nullable().optional(),
  chatwootSectorRoutes: z.array(chatwootSectorRouteSchema).max(3).optional(),
  businessHours: businessHoursSchema.optional(),
}).partial();
const toolAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
  z.object({ type: z.literal("basic"), username: z.string().min(1), password: z.string().min(1) }),
  z.object({ type: z.enum(["apiKey", "header"]), headerName: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), value: z.string().min(1) }),
]);
const toolSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().url().nullable().optional(),
  timeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  auth: toolAuthSchema.nullable().optional(),
});
const catalogSyncSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().int().min(15).max(10_080).default(240),
  sourceUrl: z.string().url().max(1_500).optional(),
  itemsPath: z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/).max(180).default("items"),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(20_000),
  auth: toolAuthSchema.nullable().optional(),
});
const setupSchema = settingsSchema.extend({
  importQuickReplies: z.boolean().default(false),
  provider: providerSchema.optional(),
});
const webhookSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  event: z.string(),
  message_type: z.union([z.string(), z.number()]),
  content: z.string().nullable().optional(),
  private: z.boolean().optional(),
  account: z.object({ id: z.union([z.string(), z.number()]) }).passthrough().optional(),
  inbox: z.object({ id: z.union([z.string(), z.number()]) }).passthrough().optional(),
  sender: z.object({
    name: z.string().nullable().optional(),
    phone_number: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  }).passthrough().optional(),
  conversation: z.object({
    id: z.union([z.string(), z.number()]),
    inbox_id: z.union([z.string(), z.number()]).optional(),
    meta: z.object({
      assignee: z.unknown().nullable().optional(),
      sender: z.object({
        name: z.string().nullable().optional(),
        phone_number: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
const improvementOutcomeSchema = z.object({
  status: z.nativeEnum(CommercialOutcomeStatus),
  source: z.string().trim().min(1).max(160).default("manual"),
  confidence: z.number().min(0).max(1).default(1),
  evidence: z.array(z.unknown()).max(100).default([]),
});
const commerceLinkSchema = z.object({
  kind: z.nativeEnum(CommerceLinkKind),
  source: z.string().trim().min(1).max(160),
  externalId: z.string().trim().min(1).max(300),
  status: z.string().trim().min(1).max(100),
  value: z.number().nonnegative().nullable().optional(),
  currency: z.string().trim().length(3).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  verificationStatus: z.nativeEnum(CommerceVerificationStatus).default(CommerceVerificationStatus.UNVERIFIED),
  verificationEvidence: z.record(z.unknown()).default({}),
  observedAt: z.coerce.date().nullable().optional(),
});
const humanFeedbackSchema = z.object({
  messageId: z.string().trim().min(1).nullable().optional(),
  verdict: z.nativeEnum(HumanFeedbackVerdict),
  score: z.number().int().min(-100).max(100).nullable().optional(),
  comment: z.string().max(10_000).nullable().optional(),
  expectedResponse: z.string().max(30_000).nullable().optional(),
  reviewerId: z.string().trim().min(1).max(200).default("admin"),
  source: z.string().trim().min(1).max(160).default("admin"),
  metadata: z.record(z.unknown()).default({}),
});
const assistantPromptBundleSchema = z.object({
  system: z.string().max(30_000).default(""),
  commercial: z.string().max(20_000).default(""),
  support: z.string().max(20_000).default(""),
  postSale: z.string().max(20_000).default(""),
});
const promptVersionSchema = z.object({
  definitionName: z.string().trim().min(1).max(160).default(continuousImprovementConstants.assistantPromptName),
  description: z.string().max(2_000).nullable().optional(),
  content: z.union([z.string().max(90_000), assistantPromptBundleSchema]),
  createdBy: z.string().trim().min(1).max(200).default("admin"),
});
const learningDiscoverySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(2_000).default(500),
  maxCandidates: z.number().int().min(1).max(40).default(32),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});
const learningReviewSchema = z.object({
  candidateIds: z.array(z.string().trim().min(1)).min(1).max(100),
  decision: z.nativeEnum(LearningReviewDecision),
  note: z.string().max(5_000).nullable().optional(),
});
const learningGroundingReferenceSchema = z.object({
  type: z.enum(["RAG_DOCUMENT", "BUSINESS_RULE", "TOOL_CONFIG"]),
  sourceId: z.string().trim().min(1).max(500),
  checksum: z.string().trim().min(1).max(200).optional(),
});
const tenantCreateSchema = z.object({
  slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  name: z.string().trim().min(1).max(160),
  botName: z.string().trim().min(1).max(100).optional(),
  language: z.string().trim().min(2).max(35).default("pt-BR"),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/iu).default("#2563eb"),
  deferIntegrations: z.boolean().default(false),
  active: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const tenantUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  botName: z.string().trim().min(1).max(100).optional(),
  slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).optional(),
  deferIntegrations: z.boolean().optional(),
  active: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const adminUserCreateSchema = z.object({
  email: z.string().trim().email().max(254).optional(),
  username: z.string().trim().email().max(254).optional(),
  name: z.string().trim().min(1).max(160),
  password: z.string().min(12).max(1_024),
  role: z.nativeEnum(AdminRole).default(AdminRole.TENANT_USER),
  tenantIds: z.array(z.string().trim().min(1)).max(500).default([]),
  active: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).refine(value => Boolean(value.email || value.username), {
  message: "email_required",
  path: ["email"],
});
const adminUserUpdateSchema = z.object({
  email: z.string().trim().email().max(254).optional(),
  username: z.string().trim().email().max(254).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  active: z.boolean().optional(),
  enabled: z.boolean().optional(),
  role: z.nativeEnum(AdminRole).optional(),
  tenantIds: z.array(z.string().trim().min(1)).max(500).optional(),
  password: z.string().min(12).max(1_024).optional(),
});

async function conversationForTenant(tenantId: string, externalId: string) {
  return prisma.conversation.findUnique({
    where: { tenantId_externalId: { tenantId, externalId } },
  });
}

function sendImprovementError(reply: FastifyReply, error: unknown) {
  if (error instanceof ContinuousImprovementError) {
    const status = error.code.endsWith("_not_found") || error.code === "conversation_not_found"
      ? 404
      : error.code.includes("conflict") ? 409 : 400;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return reply.code(409).send({ error: "conflict", message: "O registro já existe." });
  }
  app.log.error(error, "continuous improvement request failed");
  return reply.code(500).send({
    error: "continuous_improvement_failed",
    message: error instanceof Error ? error.message : "Falha inesperada",
  });
}

function matchesSecret(expected: string, received: string | undefined) {
  if (!received) return false;
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(received).digest();
  return timingSafeEqual(left, right);
}

function commercialTokenForTenant(tenantId: string) {
  if (!commercialEventsToken || commercialEventsToken.length < 24) {
    throw new AdminAuthError(
      "commercial_events_not_configured",
      "A credencial mestra de eventos comerciais não está configurada.",
      503,
    );
  }
  const signature = createHmac("sha256", commercialEventsToken)
    .update(`commercial-events:${tenantId}`, "utf8")
    .digest("base64url");
  return `commercial.v1.${tenantId}.${signature}`;
}

function bootstrapPrincipal(): AdminPrincipal {
  return {
    userId: "bootstrap",
    sessionId: "bootstrap",
    email: "bootstrap@local",
    name: "Administrador de bootstrap",
    role: AdminRole.PLATFORM_ADMIN,
    capabilities: adminCapabilities,
    tenantIds: [],
    expiresAt: new Date(8_640_000_000_000_000),
  };
}

function commercialIntegrationPrincipal(tenantId: string): AdminPrincipal {
  return {
    userId: "commercial-integration",
    sessionId: `commercial:${tenantId}`,
    email: "commercial-integration@local",
    name: "Integração comercial",
    role: AdminRole.TENANT_USER,
    capabilities: ["tenant:read", "tenant:write"],
    tenantIds: [tenantId],
    expiresAt: new Date(8_640_000_000_000_000),
  };
}

function bearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
}

function principal(request = requestContext.getStore()) {
  if (!request) throw new AdminAuthError("request_context_missing", "Contexto da requisição ausente.", 500);
  const value = requestPrincipals.get(request);
  if (!value) throw new AdminAuthError("unauthorized", "Autenticação necessária.", 401);
  return value;
}

function sendAccessError(reply: FastifyReply, error: unknown) {
  if (error instanceof AdminAuthError || error instanceof ProviderAccessError || error instanceof NexusSsoError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  app.log.error(error, "administrative access request failed");
  return reply.code(500).send({ error: "admin_request_failed", message: "Falha administrativa inesperada." });
}

app.addHook("onRequest", (request, _reply, done) => {
  requestContext.run(request, done);
});

app.addHook("onRequest", async (request, reply) => {
  if (!request.url.startsWith("/admin/") && !request.url.startsWith("/v1/")) return;
  const path = request.url.split("?", 1)[0];
  if (path === "/admin/auth/login" || path === "/admin/auth/nexus") return;
  if (request.url.startsWith("/v1/commercial/events")) {
    if (!commercialEventsToken || commercialEventsToken.length < 24) {
      return reply.code(503).send({ error: "commercial_events_not_configured" });
    }
    const rawTenantId = request.headers["x-tenant-id"];
    const tenantId = Array.isArray(rawTenantId) ? rawTenantId[0] : rawTenantId;
    if (!tenantId) {
      return reply.code(400).send({ error: "tenant_required", message: "Envie X-Tenant-Id." });
    }
    const received = typeof request.headers.authorization === "string"
      && request.headers.authorization.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : undefined;
    if (!matchesSecret(commercialTokenForTenant(tenantId), received)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    requestPrincipals.set(request, commercialIntegrationPrincipal(tenantId));
    return;
  }
  const token = bearerToken(request);
  if (!token) return reply.code(401).send({ error: "unauthorized" });
  if (matchesSecret(adminToken, token)) {
    requestPrincipals.set(request, bootstrapPrincipal());
    return;
  }
  try {
    requestPrincipals.set(request, await adminAuth.authenticateBearer(token));
  } catch (error) {
    return sendAccessError(reply, error);
  }
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof AdminAuthError || error instanceof ProviderAccessError || error instanceof NexusSsoError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  app.log.error(error);
  return reply.send(error);
});

type TenantRow = Awaited<ReturnType<typeof prisma.tenant.findFirstOrThrow>>;

async function tenant(
  capability: "tenant:read" | "tenant:write" = "tenant:read",
  request = requestContext.getStore(),
) {
  if (!request || !request.url.startsWith("/admin/") && !request.url.startsWith("/v1/")) {
    throw new AdminAuthError("tenant_required", "Selecione uma empresa explicitamente.", 400);
  }
  const currentPrincipal = principal(request);
  const rawSelection = request.headers["x-tenant-id"];
  const selection = Array.isArray(rawSelection) ? rawSelection[0] : rawSelection;
  if (!selection) {
    if (currentPrincipal.tenantIds.length === 1) {
      const onlyTenant = await prisma.tenant.findFirst({
        where: { id: currentPrincipal.tenantIds[0], active: true },
      });
      if (onlyTenant) return onlyTenant;
    }
    throw new AdminAuthError(
      "tenant_required",
      "Selecione uma empresa usando o header X-Tenant-Id.",
      400,
    );
  }
  const selected = await prisma.tenant.findFirst({
    where: {
      active: true,
      id: selection,
    },
  });
  if (!selected) throw new AdminAuthError("tenant_not_found", "Empresa ativa não encontrada.", 404);
  requireTenantAuthorization(currentPrincipal, selected.id, capability);
  return selected;
}

type ProviderRow = Awaited<ReturnType<typeof prisma.providerConfig.findFirstOrThrow>>;
type ProviderOptions = z.infer<typeof providerOptionsSchema>;
async function configuredProviders(currentTenant: TenantRow) {
  const configs = await providerAccess.listForTenant(currentTenant.id, { enabledOnly: false });
  const activeConfigs = configs.filter(row => row.enabled);
  const providers: AiProvider[] = [];
  const configurationFailures: Array<{ provider: string; error: string }> = [];
  for (const row of activeConfigs) {
    try {
      const apiKey = decrypt(row.encryptedApiKey);
      const configured = options(row);
      if (row.type !== "ollama" && !apiKey) throw new Error("API key não configurada");
      const provider = row.type === "ollama"
        ? new OllamaProvider(row.baseUrl || process.env.OLLAMA_URL || "http://localhost:11434", row.model, configured.timeoutMs, row.name)
        : providerFrom({
            type: row.type as "cloudflare" | "openrouter" | "gemini" | "openai-compatible",
            name: row.name,
            model: row.model,
            baseUrl: row.baseUrl,
            apiKey,
            timeoutMs: configured.timeoutMs,
            healthPath: configured.healthPath,
          });
      providers.push(withCompletionDefaults(provider, {
        temperature: configured.temperature,
        maxTokens: configured.maxTokens,
      }));
    } catch (error) {
      configurationFailures.push({ provider: row.name, error: error instanceof Error ? error.message : "configuração inválida" });
    }
  }
  return { tenant: currentTenant, configs, providers, configurationFailures };
}

async function providerByKey(key: string) {
  return prisma.providerConfig.findFirst({
    where: { OR: [{ id: key }, { type: key }, { name: key }] },
    orderBy: { priority: "asc" },
  });
}

async function validateProviderScope(scope: ProviderScope, tenantIds: readonly string[]) {
  if (scope === ProviderScope.ALL) return;
  const uniqueIds = [...new Set(tenantIds)];
  if (!uniqueIds.length) {
    throw new ProviderAccessError(
      "selected_tenants_required",
      "Selecione ao menos uma empresa para este provider.",
      400,
    );
  }
  const activeCount = await prisma.tenant.count({
    where: { id: { in: uniqueIds }, active: true },
  });
  if (activeCount !== uniqueIds.length) {
    throw new ProviderAccessError(
      "invalid_selected_tenant",
      "Uma das empresas selecionadas não existe ou está inativa.",
      400,
    );
  }
}

function instantiateProvider(row: ProviderRow) {
  const configured = options(row);
  if (row.type === "ollama") {
    return new OllamaProvider(row.baseUrl || process.env.OLLAMA_URL || "http://localhost:11434", row.model, configured.timeoutMs, row.name);
  }
  return providerFrom({
    type: row.type as "cloudflare" | "openrouter" | "gemini" | "openai-compatible",
    name: row.name,
    model: row.model,
    baseUrl: row.baseUrl,
    apiKey: decrypt(row.encryptedApiKey),
    timeoutMs: configured.timeoutMs,
    healthPath: configured.healthPath,
  });
}

function publicProvider(row: ProviderRow & { tenantAccesses?: Array<{ tenantId: string }> }) {
  const { encryptedApiKey, tenantId, tenantAccesses, ...safe } = row;
  return {
    ...safe,
    scopeMode: safe.scope,
    hasApiKey: Boolean(encryptedApiKey),
    tenantIds: tenantAccesses?.map(access => access.tenantId) ?? [],
  };
}

function configuredChatwootInboxIds(settings: Record<string, unknown>) {
  return [...new Set([
    ...(typeof settings.chatwootInboxId === "string" ? [settings.chatwootInboxId] : []),
    ...(Array.isArray(settings.chatwootInboxIds)
      ? settings.chatwootInboxIds.filter((value): value is string => typeof value === "string")
      : []),
  ].map(value => value.trim()).filter(Boolean))];
}

function chatwoot(settings: Record<string, unknown>): ChatwootClient {
  const token = decrypt(typeof settings.chatwootApiToken === "string" ? settings.chatwootApiToken : undefined);
  if (typeof settings.chatwootUrl !== "string" || typeof settings.chatwootAccountId !== "string" || !token) {
    throw new Error("Configure URL, Account ID e API token do Chatwoot no painel");
  }
  const config: ChatwootConfig = {
    url: settings.chatwootUrl,
    accountId: settings.chatwootAccountId,
    apiToken: token,
    teamId: typeof settings.chatwootTeamId === "number" ? settings.chatwootTeamId : undefined,
    assigneeId: typeof settings.chatwootAssigneeId === "number" ? settings.chatwootAssigneeId : undefined,
    inboxId: configuredChatwootInboxIds(settings)[0],
    inboxIds: configuredChatwootInboxIds(settings),
  };
  return new ChatwootClient(config);
}

function chatwootSectorAssignment(
  settings: Record<string, unknown>,
  sector: ConversationSector | undefined,
): ChatwootAssignment | undefined {
  if (!sector || !Array.isArray(settings.chatwootSectorRoutes)) return undefined;
  const route = settings.chatwootSectorRoutes.find((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
    return (candidate as Record<string, unknown>).sector === sector;
  });
  if (typeof route !== "object" || route === null || Array.isArray(route)) return undefined;
  const value = route as Record<string, unknown>;
  if (typeof value.teamId !== "number" || !Number.isInteger(value.teamId) || value.teamId <= 0) return undefined;
  return {
    teamId: value.teamId,
    ...(typeof value.assigneeId === "number" && Number.isInteger(value.assigneeId) && value.assigneeId > 0
      ? { assigneeId: value.assigneeId }
      : {}),
  };
}

function protectedWebhookUrl(settings: Record<string, unknown>, tenantSlug: string) {
  if (typeof settings.chatwootWebhookUrl !== "string") throw new Error("Configure a URL do webhook do Chatwoot no painel");
  const url = new URL(settings.chatwootWebhookUrl);
  const secret = decrypt(typeof settings.webhookSecret === "string" ? settings.webhookSecret : undefined);
  if (!secret) throw new Error("Configure um segredo para proteger o webhook do Chatwoot");
  const basePath = url.pathname.replace(/\/+$/, "");
  const canonicalBase = basePath.replace(/\/webhooks\/chatwoot(?:\/[^/]+)?$/u, "/webhooks/chatwoot");
  url.pathname = `${canonicalBase}/${encodeURIComponent(tenantSlug)}`;
  url.searchParams.set("secret", secret);
  return url.toString();
}

async function testChatwootIntegration(
  settings: Record<string, unknown>,
  currentTenant: TenantRow,
  legacySlugs: readonly string[] = [],
) {
  if (!configuredChatwootInboxIds(settings).length) {
    throw new Error("Configure ao menos um Inbox ID do Chatwoot para esta empresa");
  }
  const client = chatwoot(settings);
  const connection = await client.testConnection();
  const ensured = await client.ensureWebhook(
    protectedWebhookUrl(settings, currentTenant.id),
    `AI Gateway - ${currentTenant.id}`.slice(0, 120),
    [currentTenant.slug, ...legacySlugs].map(slug => `AI Gateway · ${slug}`.slice(0, 120)),
  );
  const serviceCard = await client.ensureConversationCustomAttributes(serviceCardDefinitions);
  const value = ensured.webhook && typeof ensured.webhook === "object" ? ensured.webhook as Record<string, unknown> : {};
  const id = typeof value.id === "number" || typeof value.id === "string" ? value.id : undefined;
  return {
    ...connection,
    webhook: { action: ensured.action, ...(id === undefined ? {} : { id }) },
    serviceCard,
  };
}

function options(row?: ProviderRow): ProviderOptions {
  const parsed = providerOptionsSchema.safeParse(row?.options);
  return parsed.success ? parsed.data : providerOptionsSchema.parse({});
}

function decodeToolAuth(value: string | null): ToolAuth | undefined {
  const decrypted = decrypt(value);
  if (!decrypted) return undefined;
  const parsed = toolAuthSchema.safeParse(JSON.parse(decrypted));
  if (!parsed.success) throw new Error("Autenticação persistida da Tool é inválida");
  return parsed.data;
}

function nexusAssistantEndpoint(tenantSlug: string) {
  // Tool endpoints are tenant-private data, kept in omnichannel-data (and its
  // encrypted backup), not in public source or deployment environment files.
  try {
    const path = String(process.env.NEXUS_ASSISTANT_ENDPOINTS_PATH ?? "/private-data/config/assistant-endpoints.json").trim();
    const endpoints = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const endpoint = endpoints[tenantSlug];
    if (typeof endpoint !== "string" || !endpoint.trim()) return undefined;
    const parsed = new URL(endpoint);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    app.log.warn("Private assistant endpoint map is unavailable; built-in Nexus tools are disabled");
    return undefined;
  }
}

function nexusAssistantToken(tenantSlug: string) {
  const secret = String(process.env.COMMERCIAL_EVENTS_TOKEN ?? "").trim();
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(`nexus-assistant:${tenantSlug}`).digest("base64url");
}

function builtinNexusTools(currentTenant: TenantRow, configuredNames: ReadonlySet<string>) {
  const endpoint = nexusAssistantEndpoint(currentTenant.slug);
  const token = nexusAssistantToken(currentTenant.slug);
  if (!endpoint || !token) return [];
  return ["consultarCliente", "consultarOS", "agendamento"]
    .filter(name => !configuredNames.has(name))
    .map(name => createHttpToolAdapter({
      name,
      endpoint,
      timeoutMs: 8_000,
      auth: { type: "bearer", token },
    }));
}

async function configuredHttpTools(currentTenant: TenantRow) {
  const rows = await prisma.toolConfig.findMany({ where: { tenantId: currentTenant.id, enabled: true }, orderBy: { name: "asc" } });
  const configured = rows.flatMap((row) => {
    if (!row.endpoint) return [];
    try {
      return [createHttpToolAdapter({
        name: row.name,
        endpoint: row.endpoint,
        timeoutMs: row.timeoutMs,
        auth: decodeToolAuth(row.encryptedAuth),
      })];
    } catch (error) {
      app.log.error(error, `invalid Tool configuration: ${row.name}`);
      return [];
    }
  });
  return [...configured, ...builtinNexusTools(currentTenant, new Set(configured.map(tool => tool.name)))];
}

async function saveTenantSettings(currentTenant: Awaited<ReturnType<typeof tenant>>, value: z.infer<typeof settingsSchema>) {
  const existing = currentTenant.settings as Record<string, unknown>;
  const submittedToken = value.chatwootApiToken;
  const submittedSecret = value.webhookSecret;
  const normalizedValue: Record<string, unknown> = {
    ...value,
    ...(typeof value.timezone === "string" ? {
      businessHours: { ...((existing.businessHours && typeof existing.businessHours === "object") ? existing.businessHours : {}), ...(value.businessHours ?? {}), timezone: value.timezone },
    } : {}),
  };
  const shouldProtectWebhook = Boolean(
    (value.chatwootWebhookUrl ?? existing.chatwootWebhookUrl)
    && (value.chatwootAccountId ?? existing.chatwootAccountId)
    && (submittedToken || existing.chatwootApiToken),
  );
  const settings = mergeTenantSettings(existing, {
    ...normalizedValue,
    chatwootApiToken: submittedToken === undefined
      ? existing.chatwootApiToken
      : submittedToken === null ? null : encrypt(submittedToken),
    webhookSecret: submittedSecret === undefined
      ? existing.webhookSecret ?? (shouldProtectWebhook ? encrypt(randomBytes(32).toString("base64url")) : undefined)
      : submittedSecret === null ? null : encrypt(submittedSecret),
  });
  const updated = await prisma.tenant.update({
    where: { id: currentTenant.id },
    data: {
      ...(typeof value.companyName === "string" ? { name: value.companyName } : {}),
      settings: settings as Prisma.InputJsonObject,
    },
  });
  return updated;
}

function contextualPrompt(sector: ConversationSector | undefined, identity: ReturnType<typeof promptSettings>) {
  if (sector === "postSale") return identity.postSale ? `Diretrizes de pós-venda: ${identity.postSale}` : "";
  if (sector === "commercial") return identity.commercial ? `Diretrizes comerciais: ${identity.commercial}` : "";
  if (sector === "support") return identity.support ? `Diretrizes de suporte: ${identity.support}` : "";
  return "";
}

function calculateCost(result: CompletionResult, config?: ProviderRow): number | undefined {
  if (result.estimatedCost !== undefined) return result.estimatedCost;
  const configured = options(config);
  if (result.inputTokens === undefined && result.outputTokens === undefined) return undefined;
  return ((result.inputTokens ?? 0) * configured.inputCostPerMillion + (result.outputTokens ?? 0) * configured.outputCostPerMillion) / 1_000_000;
}

const conversationQueues = new Map<string, Promise<unknown>>();
const serviceCardDefinitions = [
  { key: "atendimento_conversa_id", name: "ID da conversa", description: "Identificador técnico da conversa no Chatwoot." },
  { key: "atendimento_nome", name: "Nome", description: "Nome confirmado durante o atendimento." },
  { key: "atendimento_telefone", name: "Telefone", description: "Telefone confirmado durante o atendimento." },
  { key: "atendimento_cpf", name: "CPF", description: "CPF confirmado durante o atendimento." },
  { key: "atendimento_email", name: "E-mail", description: "E-mail confirmado durante o atendimento." },
  { key: "atendimento_aparelho", name: "Aparelho", description: "Família do dispositivo Apple." },
  { key: "atendimento_modelo", name: "Modelo", description: "Modelo informado pelo cliente." },
  { key: "atendimento_servico", name: "Serviço", description: "Serviço ou reparo desejado." },
  { key: "atendimento_unidade_desejada", name: "Unidade desejada", description: "Unidade preferida pelo cliente." },
  { key: "atendimento_unidade_agendamento", name: "Unidade de agendamento", description: "Unidade escolhida para o agendamento." },
  { key: "atendimento_data_hora", name: "Data e horário", description: "Data e horário escolhidos para o atendimento." },
  { key: "atendimento_agendamento_id", name: "ID do agendamento", description: "Identificador retornado pelo Zoho Creator." },
  { key: "atendimento_status", name: "Status do atendimento", description: "Situação atual do atendimento ou agendamento." },
] as const;

function serviceCardAttributes(conversationId: string, state: ConversationState) {
  const values: Record<string, string | undefined> = {
    atendimento_conversa_id: conversationId,
    atendimento_nome: state.nome,
    atendimento_telefone: state.telefone,
    atendimento_cpf: state.cpf,
    atendimento_email: state.email,
    atendimento_aparelho: state.aparelho ?? state.modelo?.match(/^(?:iPhone|iPad|MacBook|iMac|Apple Watch)/iu)?.[0],
    atendimento_modelo: state.modelo,
    atendimento_servico: state.servico ?? state.defeito,
    atendimento_unidade_desejada: state.unidadeDesejada ?? state.cidade,
    atendimento_unidade_agendamento: state.unidadeAgendamento,
    atendimento_data_hora: [state.dataDesejada, state.horarioDesejado].filter(Boolean).join(" ") || undefined,
    atendimento_agendamento_id: state.agendamentoId,
    atendimento_status: state.statusAgendamento ?? "Em atendimento",
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  );
}

const appointmentIntentPattern = /\b(?:agendar|marcar|remarcar|quero\s+(?:um\s+)?agendamento)\b/iu;
const appointmentFieldLabels: Record<string, string> = {
  nome: "nome",
  telefone: "telefone",
  modelo: "aparelho e modelo",
  servico: "serviço desejado",
  unidade: "unidade desejada",
  dataDesejada: "data desejada",
  horarioDesejado: "horário desejado",
};

function missingAppointmentFields(state: ConversationState) {
  return [
    !state.nome && "nome",
    !state.telefone && "telefone",
    !(state.modelo || state.aparelho) && "modelo",
    !(state.servico || state.defeito) && "servico",
    !(state.unidadeAgendamento || state.unidadeDesejada) && "unidade",
    !state.dataDesejada && "dataDesejada",
    !state.horarioDesejado && "horarioDesejado",
  ].filter((field): field is string => Boolean(field));
}

function appointmentQualificationAnswer(state: ConversationState, missing: string[]) {
  if (missing.length) {
    return `Para encaminhar seu pedido de agendamento, preciso confirmar: ${missing
      .map(field => appointmentFieldLabels[field])
      .join(", ")}. Pode me informar esses dados?`;
  }
  const details = [
    state.nome && `nome: ${state.nome}`,
    state.telefone && `telefone: ${state.telefone}`,
    (state.modelo || state.aparelho) && `aparelho: ${state.modelo ?? state.aparelho}`,
    (state.servico || state.defeito) && `serviço: ${state.servico ?? state.defeito}`,
    (state.unidadeAgendamento || state.unidadeDesejada) && `unidade: ${state.unidadeAgendamento ?? state.unidadeDesejada}`,
    `data e horário: ${state.dataDesejada} ${state.horarioDesejado}`,
  ].filter(Boolean);
  return `Obrigado. Anotei ${details.join("; ")}. Vou encaminhar a conversa para um atendente verificar a disponibilidade e concluir o agendamento.`;
}

async function updateChatwootServiceCard(
  settings: Record<string, unknown>,
  conversationId: string,
  state: ConversationState,
) {
  await chatwoot(settings).updateConversationCustomAttributes(
    conversationId,
    serviceCardAttributes(conversationId, state),
  );
}

function enqueue<T>(tenantId: string, conversationId: string, task: () => Promise<T>): Promise<T> {
  const queueKey = `${tenantId}:${conversationId}`;
  const previous = conversationQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  conversationQueues.set(queueKey, current);
  const cleanup = () => { if (conversationQueues.get(queueKey) === current) conversationQueues.delete(queueKey); };
  void current.then(cleanup, cleanup);
  return current;
}

async function writeLog(data: Prisma.AiLogUncheckedCreateInput) {
  try { await prisma.aiLog.create({ data }); }
  catch (error) { app.log.error(error, "failed to persist audit log"); }
}

async function unambiguousConversationPromptVersion(conversationId: string) {
  const messages = await prisma.conversationMessage.findMany({
    where: { conversationId, role: "assistant" },
    select: { promptVersionId: true },
  });
  if (!messages.length || messages.some(message => !message.promptVersionId)) return null;
  const versions = new Set(messages.map(message => message.promptVersionId));
  return versions.size === 1 ? messages[0]!.promptVersionId : null;
}

async function evaluateConversationState(tenantId: string, conversationId: string) {
  return continuousImprovement.runAutomaticEvaluation({
    tenantId,
    conversationId,
    promptVersionId: await unambiguousConversationPromptVersion(conversationId),
  });
}

function scheduleConversationEvaluation(
  tenantId: string,
  conversationId: string,
  conversationExternalId: string,
) {
  void (async () => {
    const evaluation = await evaluateConversationState(tenantId, conversationId);
    await learningCandidates.discoverFromEvaluations({
      tenantId,
      since: new Date(evaluation.createdAt.getTime() - 1_000),
      limit: 100,
      maxCandidates: 32,
      evaluator: continuousImprovementConstants.evaluator,
      evaluatorVersion: continuousImprovementConstants.evaluatorVersion,
    });
  })().catch(async error => {
    await writeLog({
      tenantId,
      conversationExternalId,
      level: "error",
      message: `Falha na avaliação ou consolidação de aprendizado: ${error instanceof Error ? error.message : "erro desconhecido"}`,
    });
  });
}

async function processMessage(
  currentTenant: TenantRow,
  conversationExternalId: string,
  input: string,
  externalMessageId?: string,
  deliver = true,
  humanAssigned = false,
  contactState: ConversationState = {},
) {
  const { configs, providers, configurationFailures } = await configuredProviders(currentTenant);
  const settings = currentTenant.settings as Record<string, unknown>;
  const injectionAssessment = assessPromptInjection(input);
  const operationalInput = injectionAssessment.detected ? injectionAssessment.safeText : input;
  const conversation = await prisma.conversation.upsert({
    where: { tenantId_externalId: { tenantId: currentTenant.id, externalId: conversationExternalId } },
    update: {},
    create: { tenantId: currentTenant.id, externalId: conversationExternalId },
  });

  try {
    await prisma.conversationMessage.create({ data: { conversationId: conversation.id, externalId: externalMessageId, role: "user", content: input } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && externalMessageId) return { duplicate: true, content: null };
    throw error;
  }
  if (injectionAssessment.detected) {
    await writeLog({
      tenantId: currentTenant.id,
      conversationExternalId,
      level: "warn",
      message: `Tentativa de controle de prompt neutralizada: ${injectionAssessment.signals.join(", ")}`,
    });
  }
  const hasCommercialOutcome = await prisma.commercialOutcome.findFirst({
    where: { tenantId: currentTenant.id, conversationId: conversation.id },
    select: { id: true },
  });
  if (!hasCommercialOutcome) {
    await continuousImprovement.recordCommercialOutcome({
      tenantId: currentTenant.id,
      conversationId: conversation.id,
      status: CommercialOutcomeStatus.PENDING,
      source: "conversation_started",
      confidence: 0.25,
      evidence: [],
      createdBy: "system",
    });
  }

  if (humanAssigned && !automationSuppressed(conversation.status)) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "human_assigned" } });
    await writeLog({
      tenantId: currentTenant.id,
      conversationExternalId,
      level: "info",
      message: "Mensagem registrada sem resposta automática: conversa já atribuída no Chatwoot",
    });
    return { duplicate: false, suppressed: true, content: null };
  }

  // `telefoneCanal` originates only from a validated Chatwoot webhook. Keep it
  // separate from `telefone`, which may have been typed by anyone in the chat.
  // A typed telephone is valid intake data, but never proof for a private lookup.
  const previousState = { ...(conversation.state as ConversationState), ...contactState };
  const state = extractConversationState(operationalInput, previousState);
  if (contactState.telefoneCanal) state.telefoneCanal = contactState.telefoneCanal;
  const agentRoute = routeSpecializedAgent({
    message: operationalInput,
    previousRole: previousState.activeAgent as Parameters<typeof routeSpecializedAgent>[0]["previousRole"],
    state: previousState,
  });
  state.activeAgent = agentRoute.role;
  const sector = detectConversationSector(operationalInput, previousState.sector);
  if (sector) state.sector = sector;
  const appointmentIntent = previousState.intencaoAgendamento === "true" || appointmentIntentPattern.test(operationalInput);
  if (appointmentIntent) state.intencaoAgendamento = "true";
  const missingForAppointment = appointmentIntent ? missingAppointmentFields(state) : [];
  const appointmentQualified = appointmentIntent && missingForAppointment.length === 0;
  if (appointmentQualified) state.statusAgendamento = "Aguardando atendente";
  else if (appointmentIntent) state.statusAgendamento = "Coletando dados";
  if (JSON.stringify(state) !== JSON.stringify(previousState)) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { state } });
  }
  if (deliver) {
    try {
      await updateChatwootServiceCard(settings, conversationExternalId, state);
    } catch (error) {
      await writeLog({
        tenantId: currentTenant.id,
        conversationExternalId,
        level: "error",
        message: `Falha ao atualizar cartão no Chatwoot: ${error instanceof Error ? error.message : "erro desconhecido"}`,
      });
    }
  }

  if (automationSuppressed(conversation.status)) {
    await writeLog({
      tenantId: currentTenant.id,
      conversationExternalId,
      level: "info",
      message: "Mensagem registrada sem resposta automática: conversa atribuída ao atendimento humano",
    });
    return { duplicate: false, suppressed: true, content: null };
  }

  const messageCount = await prisma.conversationMessage.count({ where: { conversationId: conversation.id } });
  if (messageCount > 50 && messageCount % 20 === 11) {
    const older = await prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      skip: 20,
      take: Math.min(messageCount - 20, 200),
    });
    older.reverse();
    const summaryInput = conversation.summary
      ? [{ role: "summary", content: conversation.summary }, ...older]
      : older;
    await prisma.conversation.update({ where: { id: conversation.id }, data: { summary: deterministicSummary(summaryInput, state) } });
  }
  const current = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  const history = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "desc" }, take: 20 });
  const scriptedSecurityAnswer = injectionAssessment.detected && !operationalInput
    ? "Posso ajudar com o atendimento da empresa, mas não posso alterar minhas regras internas nem revelar instruções ou credenciais. Qual necessidade legítima você quer resolver?"
    : undefined;
  const scriptedAppointmentAnswer = scriptedSecurityAnswer
    ? undefined
    : appointmentIntent
      ? appointmentQualificationAnswer(state, missingForAppointment)
      : undefined;
  const scriptedIntakeAnswer = scriptedAppointmentAnswer
    ? undefined
    : proactiveIntakeAnswer(operationalInput, state, messageCount);
  let scriptedAnswer = scriptedSecurityAnswer ?? scriptedAppointmentAnswer ?? scriptedIntakeAnswer;

  let toolError: string | undefined;
  let usedTools: Awaited<ReturnType<typeof runConfiguredTools>> = [];
  try {
    {
      const httpTools = await configuredHttpTools(currentTenant);
      const toolContext = { tenantId: currentTenant.id, conversationExternalId, state };
      if (!scriptedAnswer) usedTools = await runConfiguredTools(operationalInput, httpTools, toolContext);
      // Customer/OS data can only be read with a channel number supplied by
      // Chatwoot or a CPF explicitly supplied by the customer. A number parsed
      // from message text alone is deliberately not accepted as authorization.
      const customerTool = messageCount === 1 && (state.telefoneCanal || state.cpf)
        ? httpTools.find(tool => tool.name === "consultarCliente")
        : undefined;
      if (customerTool && !usedTools.some(result => result.name === customerTool.name)) {
        usedTools.push(await customerTool.execute("consultar cliente", toolContext));
      }
      if (customerTool && usedTools.some(result => result.name === customerTool.name && result.found) && scriptedIntakeAnswer) {
        scriptedAnswer = undefined;
      }
    }
  }
  catch (error) { toolError = error instanceof Error ? error.message : "Falha em Tool"; await writeLog({ tenantId: currentTenant.id, conversationExternalId, level: "error", message: toolError }); }
  const groundingEvidence: GroundingEvidence[] = usedTools
    .filter(result => result.found)
    .map(result => ({ source: "tool", content: result.content }));
  const toolContext = usedTools.length
    ? untrustedDataEnvelope("tool", `Ferramentas:\n${usedTools.map(result => `${result.name}: ${result.content}`).join("\n")}`)
    : "";
  let ragContext = "";
  let ragSources: Array<{ title: string; score: number }> = [];
  const ragTrace: RagRetrievalTrace = {};
  if (!usedTools.some(result => result.found)) {
    try {
      const documents = await retrieve(
        prisma,
        currentTenant.id,
        operationalInput,
        /\b(?:lojas?|unidades?|endere[cç]os?)\b/iu.test(operationalInput) ? 25 : 5,
        Number(process.env.RAG_MIN_SCORE ?? 0.25),
        embeddingOptionsFromSettings(settings),
        ragTrace,
        agentRoute.role,
      );
      ragSources = documents.map(document => ({ title: document.title, score: document.score }));
      groundingEvidence.push(...documents.map(document => ({ source: "rag" as const, content: document.content })));
      ragContext = untrustedDataEnvelope(
        "rag",
        documents.length
          ? `Base da empresa:\n${documents.map(document => `- [${document.title}] ${document.content}`).join("\n")}`
          : "A base da empresa não contém informação suficiente para esta pergunta.",
      );
    } catch (error) {
      ragContext = "A base da empresa está temporariamente indisponível. Não responda fatos específicos sem uma ferramenta confiável.";
      await writeLog({ tenantId: currentTenant.id, conversationExternalId, level: "error", message: error instanceof Error ? error.message : "Falha no RAG" });
    }
  }
  const requestedHuman = transferRequested(operationalInput);
  const transferIntent = appointmentIntent ? appointmentQualified : requestedHuman;
  const openNow = inBusinessHours(settings);
  const transferPending = conversation.status === "human_pending";
  let rules = "";
  if (settings.businessRulesEnabled === true) {
    try {
      rules = settings.businessRulesDocument === undefined
        ? ""
        : businessRulesFromDocument(settings.businessRulesDocument);
    }
    catch (error) { rules = "Colete somente informações confirmadas e não invente regras de negócio."; await writeLog({ tenantId: currentTenant.id, conversationExternalId, level: "error", message: error instanceof Error ? error.message : "Falha ao interpretar bot.json" }); }
  }
  if (rules) groundingEvidence.push({ source: "business_rule", content: rules });

  let selectedPrompt: Awaited<ReturnType<typeof continuousImprovement.selectPromptVersion>> = null;
  let approvedLearningGuidance: Awaited<ReturnType<typeof learningCandidates.listApprovedGuidance>> = [];
  try {
    selectedPrompt = await continuousImprovement.selectPromptVersion({
      tenantId: currentTenant.id,
      conversationExternalId,
    });
  } catch (error) {
    await writeLog({
      tenantId: currentTenant.id,
      conversationExternalId,
      level: "error",
      message: `Falha ao selecionar versão do prompt: ${error instanceof Error ? error.message : "erro desconhecido"}`,
    });
  }
  try {
    const learningAgentRole = {
      intake: LearningAgentRole.INTAKE,
      sales: LearningAgentRole.SALES,
      customer_care: LearningAgentRole.CUSTOMER_CARE,
      technical: LearningAgentRole.TECHNICAL,
      quality: LearningAgentRole.INTAKE,
    }[agentRoute.role];
    approvedLearningGuidance = await learningCandidates.listApprovedGuidance(
      currentTenant.id,
      learningAgentRole,
    );
  } catch (error) {
    await writeLog({
      tenantId: currentTenant.id,
      conversationExternalId,
      level: "error",
      message: `Falha ao carregar aprendizado revisado: ${error instanceof Error ? error.message : "erro desconhecido"}`,
    });
  }
  const identity = applyPromptBundle(promptSettings(settings), selectedPrompt?.content);
  const contextPrompt = contextualPrompt(sector, identity);
  const agentPrompt = buildSpecializedAgentPrompt(agentRoute.role, {
    tenantId: currentTenant.id,
    companyName: identity.companyName,
    language: identity.language,
  });
  const learnedGuidancePrompt = approvedLearningGuidance.length
    ? [
      "DIRETRIZES DE COMPORTAMENTO REVISADAS POR HUMANO:",
      ...approvedLearningGuidance.slice(0, 12).map(item => (
        item.directiveType === "BEHAVIOR"
          ? `- ${item.directive}`
          : `- ${item.directive} Esta diretriz exige consulta atual à fonte oficial e não autoriza reutilizar valores vistos em conversas.`
      )),
    ].join("\n")
    : "";
  const system = [
    `Você é ${identity.botName}, assistente de ${identity.companyName}. Responda no idioma ${identity.language}, com naturalidade e objetividade.`,
    identity.system,
    agentPrompt,
    learnedGuidancePrompt,
    contextPrompt,
    messageCount === 1 && identity.welcomeMessage ? `Na abertura, use como referência esta mensagem: ${identity.welcomeMessage}` : "",
    ...tenantGuardrails(identity.companyName),
    "Quando a ferramenta de cliente encontrar um cadastro e trouxer o nome, cumprimente pelo primeiro nome e diga 'seja bem-vindo novamente' sem expor CPF, telefone ou identificadores internos. Use atendimentos anteriores apenas para oferecer continuidade relevante.",
    "Se houver agendamento recente cancelado, pergunte se deseja reagendar. Se houver atendimento recente de aparelho ou serviço, pergunte com naturalidade se deseja retomar aquele assunto; não presuma que o problema atual é o mesmo.",
    "Nunca recomende a loja mais próxima sem uma localização do cliente e sem uma ferramenta que calcule a distância. Se faltar bairro, cidade, CEP ou endereço, pergunte. Se a ferramenta não calcular, não escolha uma loja por suposição.",
    /\b(?:lojas?|unidades?|endere[cç]os?)\b/iu.test(operationalInput)
      ? "Ao informar lojas ou endereços, copie somente nomes e endereços presentes na Base da empresa. Não complete números, ruas ou unidades por suposição e não mencione uma unidade sem endereço recuperado. Antes de responder, confira se cada afirmação é compatível com a lista recuperada: nunca diga que uma cidade não possui loja se você acabou de listar uma unidade nela. Não acrescente avisos genéricos sobre falta ou desatualização de informações quando a Base trouxe a resposta."
      : "",
    appointmentIntent
      ? appointmentQualified
        ? "O cliente forneceu os dados mínimos do pré-agendamento. Não diga que o agendamento foi criado. Resuma os dados confirmados, informe que um atendente humano continuará para validar disponibilidade e concluir o agendamento, e não faça novas perguntas."
        : `O cliente quer agendar, mas ainda faltam: ${missingForAppointment.map(field => appointmentFieldLabels[field]).join(", ")}. Não transfira ainda e não diga que criou ou reservou horário. Peça de forma curta somente esses dados ausentes; não pergunte novamente o que já consta em Dados já coletados.`
      : "",
    "Responda perguntas paralelas e retome o atendimento principal. Não repita dados já presentes no estado da conversa.",
    `Dados já coletados: ${JSON.stringify(state)}.`,
    `Resumo anterior: ${current.summary || "nenhum"}.`,
    rules ? untrustedDataEnvelope("import", rules) : "",
    toolContext,
    ragContext,
    transferIntent ? (openNow
      ? `O cliente solicitou humano. Continue ajudando e informe que a conversa será encaminhada.${identity.transferMessage ? ` Mensagem configurada: ${identity.transferMessage}` : ""}`
      : `A equipe está fora do horário. Continue ajudando e informe que a solicitação humana ficará registrada.${identity.outOfHoursMessage ? ` Mensagem configurada: ${identity.outOfHoursMessage}` : ""}`) : "",
  ].filter(Boolean).join("\n\n");
  const messages = [{ role: "system" as const, content: system }, ...history.reverse().map(message => ({
    role: message.role === "assistant" ? "assistant" as const : "user" as const,
    content: message.role === "assistant" ? message.content : sanitizeUntrustedText(message.content, 8_000),
  }))];

  const started = Date.now();
  let result: RoutedCompletionResult | undefined;
  let answer = scriptedAnswer
    ?? "Não consegui acessar um provedor de IA agora. Registrei a conversa para continuidade humana.";
  let generationError: string | undefined;
  let groundingBlock: string | undefined;
  try {
    if (!scriptedAnswer) {
      for (const failure of configurationFailures) {
        await writeLog({ tenantId: currentTenant.id, conversationExternalId, provider: failure.provider, fallback: true, level: "error", message: `Configuração de provider ignorada: ${failure.error}` });
      }
      if (!providers.length) {
        const detail = configurationFailures.map(failure => `${failure.provider}: ${failure.error}`).join("; ");
        throw new Error(detail ? `Nenhum provider válido. ${detail}` : "Nenhum provider ativo com credenciais válidas");
      }
      result = await new ProviderRouter(providers).complete({ messages });
      answer = result.text;
      const grounding = assessGroundedResponse(answer, groundingEvidence);
      if (!grounding.allowed) {
        groundingBlock = grounding.violations.map(violation => violation.kind).join(", ");
        answer = safeGroundingFallback(grounding.violations);
      }
    }
  } catch (error) {
    generationError = error instanceof Error ? error.message : "Falha desconhecida dos providers";
  }

  const selectedConfig = result ? configs.find(row => row.name === result?.provider || row.type === result?.provider) : undefined;
  for (const failure of result?.failures ?? []) {
    await writeLog({
      tenantId: currentTenant.id,
      conversationExternalId,
      provider: failure.provider,
      fallback: true,
      level: "error",
      message: `Tentativa de provider falhou: ${failure.error}`,
    });
  }
  const effectivePromptVersionId = result ? selectedPrompt?.versionId : undefined;
  await prisma.conversationMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: answer,
      provider: result?.provider,
      promptVersionId: effectivePromptVersionId,
    },
  });
  await writeLog({
    tenantId: currentTenant.id,
    conversationExternalId,
    provider: result?.provider,
    model: selectedConfig?.model,
    latencyMs: Date.now() - started,
    inputTokens: result?.inputTokens,
    outputTokens: result?.outputTokens,
    estimatedCost: calculateCost(result ?? { text: answer }, selectedConfig),
    tools: usedTools.map(tool => tool.name),
    fallback: result?.fallback ?? false,
    promptVersionId: effectivePromptVersionId,
    ragSources,
    cacheHit: ragTrace.cacheHit ?? false,
    level: generationError ? "error" : "info",
    message: generationError
      ?? (groundingBlock
        ? `Agente ${agentRoute.role}: resposta bloqueada pelo Quality Gate por falta de fonte: ${groundingBlock}`
        : scriptedAnswer
          ? `Agente ${agentRoute.role}: resposta protegida gerada localmente, sem chamada a provider`
          : `Agente ${agentRoute.role}: resposta gerada; tentativas: ${result?.attemptedProviders.join(", ")}`),
  });

  const needsHuman = transferIntent || transferPending || Boolean(generationError) || Boolean(toolError);
  const nextStatus = needsHuman ? (openNow ? "human_requested" : "human_pending") : conversation.status;
  if (nextStatus !== conversation.status) await prisma.conversation.update({ where: { id: conversation.id }, data: { status: nextStatus } });

  if (deliver) {
    let client: ChatwootClient;
    try {
      client = chatwoot(settings);
      await client.sendMessage(conversationExternalId, answer);
      await writeLog({ tenantId: currentTenant.id, conversationExternalId, level: "info", message: "Resposta entregue ao Chatwoot" });
    } catch (error) {
      await writeLog({ tenantId: currentTenant.id, conversationExternalId, level: "error", message: `Falha de entrega ao Chatwoot: ${error instanceof Error ? error.message : "erro desconhecido"}` });
      throw error;
    }
    if (needsHuman && openNow) {
      try {
        await client.transferToHuman(conversationExternalId, chatwootSectorAssignment(settings, sector));
        await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "human_assigned" } });
        await writeLog({ tenantId: currentTenant.id, conversationExternalId, level: "info", message: "Conversa atribuída ao atendimento humano" });
      } catch (error) {
        await writeLog({ tenantId: currentTenant.id, conversationExternalId, level: "error", message: `Falha na transferência humana: ${error instanceof Error ? error.message : "erro desconhecido"}` });
      }
    }
  }
  if (result) {
    scheduleConversationEvaluation(currentTenant.id, conversation.id, conversationExternalId);
  }
  return { duplicate: false, content: answer };
}

async function seedTenantTools(tenantId: string) {
  for (const definition of toolDefinitions) {
    await prisma.toolConfig.upsert({
      where: { tenantId_name: { tenantId, name: definition.name } },
      update: {},
      create: { tenantId, name: definition.name },
    });
  }
}

app.post("/admin/auth/login", async (request, reply) => {
  const parsed = z.object({
    email: z.string().trim().email().max(254).optional(),
    username: z.string().trim().email().max(254).optional(),
    password: z.string().min(1).max(1_024),
  }).refine(value => Boolean(value.email || value.username)).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_credentials_payload" });
  try {
    return await adminAuth.authenticateWithPassword({
      email: parsed.data.email ?? parsed.data.username!,
      password: parsed.data.password,
    });
  } catch (error) {
    return sendAccessError(reply, error);
  }
});

app.post("/admin/auth/nexus", async (request, reply) => {
  const parsed = z.object({
    code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_sso_payload" });
  if (!nexusSso) return reply.code(503).send({ error: "sso_not_configured" });
  try {
    const claims = await nexusSso.redeem(parsed.data.code);
    return await adminAuth.authenticateWithNexus(claims);
  } catch (error) {
    return sendAccessError(reply, error);
  }
});

app.post("/admin/auth/logout", async (request) => {
  const token = bearerToken(request);
  if (!token || matchesSecret(adminToken, token)) return { revoked: false, bootstrap: true };
  return { revoked: await adminAuth.revokeBearer(token) };
});

app.get("/admin/me", async () => {
  const currentPrincipal = principal();
  const tenantRows = await prisma.tenant.findMany({
    where: currentPrincipal.role === AdminRole.PLATFORM_ADMIN
      ? {}
      : { id: { in: [...currentPrincipal.tenantIds] }, active: true },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: { id: true, slug: true, name: true, active: true, createdAt: true, settings: true },
  });
  const tenants = tenantRows.map(({ settings, ...item }) => ({
    ...item,
    botName: promptSettings(settings).botName,
  }));
  return {
    principal: {
      id: currentPrincipal.userId,
      email: currentPrincipal.email,
      name: currentPrincipal.name,
      role: currentPrincipal.role,
      bootstrap: currentPrincipal.sessionId === "bootstrap",
    },
    capabilities: currentPrincipal.capabilities,
    tenants,
  };
});

app.get("/admin/tenants", async () => {
  const currentPrincipal = principal();
  const tenantRows = await prisma.tenant.findMany({
    where: currentPrincipal.role === AdminRole.PLATFORM_ADMIN
      ? {}
      : { id: { in: [...currentPrincipal.tenantIds] }, active: true },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      active: true,
      createdAt: true,
      settings: true,
      _count: {
        select: {
          adminUsers: true,
          documents: true,
          conversations: true,
        },
      },
    },
  });
  return {
    tenants: tenantRows.map(({ settings, ...item }) => ({
      ...item,
      botName: promptSettings(settings).botName,
    })),
  };
});

app.post("/admin/tenants", async (request, reply) => {
  requireAdminCapability(principal(request), "tenants:write");
  const parsed = tenantCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  try {
    const initialSettings = buildInitialTenantSettings({
      name: parsed.data.name,
      botName: parsed.data.botName,
      language: parsed.data.language,
      primaryColor: parsed.data.primaryColor,
      deferIntegrations: parsed.data.deferIntegrations,
    });
    const created = await prisma.tenant.create({
      data: {
        slug: parsed.data.slug,
        name: parsed.data.name,
        active: parsed.data.active ?? parsed.data.enabled ?? true,
        settings: initialSettings as Prisma.InputJsonObject,
      },
      select: { id: true, slug: true, name: true, active: true, createdAt: true },
    });
    await seedTenantTools(created.id);
    return reply.code(201).send({ ...created, botName: promptSettings(initialSettings).botName });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return reply.code(409).send({ error: "tenant_slug_exists" });
    }
    throw error;
  }
});

async function updateTenantRoute(request: FastifyRequest, reply: FastifyReply) {
  requireAdminCapability(principal(request), "tenants:write");
  const parsed = tenantUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const id = String((request.params as { id: string }).id);
  try {
    const existing = await prisma.tenant.findUniqueOrThrow({ where: { id } });
    const settings = typeof parsed.data.name === "string"
      || typeof parsed.data.botName === "string"
      || typeof parsed.data.deferIntegrations === "boolean"
      ? mergeTenantSettings(existing.settings, {
          ...(parsed.data.name === undefined ? {} : { companyName: parsed.data.name }),
          ...(parsed.data.botName === undefined ? {} : { botName: parsed.data.botName }),
          ...(parsed.data.deferIntegrations === undefined
            ? {}
            : { setupDeferredAt: parsed.data.deferIntegrations ? new Date().toISOString() : null }),
        })
      : existing.settings;
    if (parsed.data.slug && parsed.data.slug !== existing.slug) {
      const duplicate = await prisma.tenant.count({
        where: { slug: parsed.data.slug, id: { not: existing.id } },
      });
      if (duplicate) return reply.code(409).send({ error: "tenant_slug_exists" });
      const rawSettings = settings as Record<string, unknown>;
      const chatwootConfigured = Boolean(
        rawSettings.chatwootUrl
        && rawSettings.chatwootAccountId
        && rawSettings.chatwootApiToken
        && rawSettings.chatwootWebhookUrl
        && rawSettings.webhookSecret
        && configuredChatwootInboxIds(rawSettings).length,
      );
      if (chatwootConfigured) {
        try {
          const client = chatwoot(rawSettings);
          await client.ensureWebhook(
            protectedWebhookUrl(rawSettings, existing.id),
            `AI Gateway - ${existing.id}`.slice(0, 120),
            [`AI Gateway · ${existing.slug}`.slice(0, 120)],
          );
        } catch (error) {
          return reply.code(502).send({
            error: "chatwoot_webhook_reconcile_failed",
            message: error instanceof Error ? error.message : "Falha ao atualizar o webhook do Chatwoot.",
          });
        }
      }
    }
    const updated = await prisma.tenant.update({
      where: { id },
      data: {
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.slug === undefined ? {} : { slug: parsed.data.slug }),
        ...(
          parsed.data.active === undefined && parsed.data.enabled === undefined
            ? {}
            : { active: parsed.data.active ?? parsed.data.enabled }
        ),
        settings: settings as Prisma.InputJsonObject,
      },
      select: { id: true, slug: true, name: true, active: true, createdAt: true, settings: true },
    });
    const { settings: updatedSettings, ...safeTenant } = updated;
    return { ...safeTenant, botName: promptSettings(updatedSettings).botName };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return reply.code(404).send({ error: "tenant_not_found" });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return reply.code(409).send({ error: "tenant_slug_exists" });
    }
    throw error;
  }
}
app.patch("/admin/tenants/:id", updateTenantRoute);
app.put("/admin/tenants/:id", updateTenantRoute);

app.get("/admin/users", async (request) => {
  requireAdminCapability(principal(request), "users:write");
  const users = await prisma.adminUser.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: {
      memberships: {
        orderBy: { createdAt: "asc" },
        select: {
          tenantId: true,
          tenant: { select: { slug: true, name: true, active: true } },
        },
      },
    },
  });
  return {
    users: users.map(({ passwordHash, externalSubject, ...user }) => ({
      ...user,
      tenantIds: user.memberships.map(item => item.tenantId),
    })),
  };
});

app.post("/admin/users", async (request, reply) => {
  requireAdminCapability(principal(request), "users:write");
  const parsed = adminUserCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  try {
    const user = await adminAuth.createUser({
      email: parsed.data.email ?? parsed.data.username!,
      name: parsed.data.name,
      password: parsed.data.password,
      role: parsed.data.role,
      tenantIds: parsed.data.tenantIds,
    });
    const requestedActive = parsed.data.active ?? parsed.data.enabled ?? true;
    if (!requestedActive) await adminAuth.setUserActive(user.id, false);
    const memberships = await prisma.adminUserTenant.findMany({
      where: { userId: user.id },
      select: { tenantId: true },
    });
    return reply.code(201).send({
      ...user,
      active: requestedActive,
      enabled: requestedActive,
      username: user.email,
      tenantIds: memberships.map(item => item.tenantId),
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return reply.code(409).send({ error: "admin_email_exists" });
    }
    return sendAccessError(reply, error);
  }
});

app.put("/admin/users/:id", async (request, reply) => {
  requireAdminCapability(principal(request), "users:write");
  const parsed = adminUserUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const userId = String((request.params as { id: string }).id);
  const existing = await prisma.adminUser.findUnique({
    where: { id: userId },
    include: { memberships: { select: { tenantId: true } } },
  });
  if (!existing) return reply.code(404).send({ error: "user_not_found" });
  if (existing.authSource === AdminAuthSource.NEXUS) {
    return reply.code(409).send({
      error: "identity_managed_by_nexus",
      message: "Esta identidade é gerenciada pelo Nexus.",
    });
  }
  const nextRole = parsed.data.role ?? existing.role;
  const nextTenantIds = [...new Set(parsed.data.tenantIds ?? existing.memberships.map(item => item.tenantId))];
  if (nextRole === AdminRole.TENANT_USER && nextTenantIds.length === 0) {
    return reply.code(400).send({ error: "tenant_membership_required" });
  }
  const activeTenantCount = nextTenantIds.length
    ? await prisma.tenant.count({ where: { id: { in: [...new Set(nextTenantIds)] }, active: true } })
    : 0;
  if (activeTenantCount !== new Set(nextTenantIds).size) {
    return reply.code(400).send({ error: "invalid_tenant_membership" });
  }
  const passwordHash = parsed.data.password === undefined
    ? undefined
    : await hashAdminPassword(parsed.data.password);
  const nextEmail = (parsed.data.email ?? parsed.data.username)?.toLowerCase();
  const nextActive = parsed.data.active ?? parsed.data.enabled;
  const now = new Date();
  const membershipsChanged = parsed.data.tenantIds !== undefined || parsed.data.role !== undefined;
  await prisma.$transaction(async transaction => {
    await transaction.adminUser.update({
      where: { id: userId },
      data: {
        ...(nextEmail === undefined ? {} : { email: nextEmail }),
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.role === undefined ? {} : { role: parsed.data.role }),
        ...(nextActive === undefined ? {} : { active: nextActive }),
        ...(passwordHash === undefined ? {} : { passwordHash, passwordChangedAt: now }),
      },
    });
    if (membershipsChanged) {
      await transaction.adminUserTenant.deleteMany({ where: { userId } });
      const membershipTenantIds = nextRole === AdminRole.PLATFORM_ADMIN ? [] : nextTenantIds;
      if (membershipTenantIds.length) {
        await transaction.adminUserTenant.createMany({
          data: membershipTenantIds.map(tenantId => ({ userId, tenantId })),
        });
      }
    }
    if (nextActive === false || passwordHash !== undefined) {
      await transaction.adminSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  const updated = await prisma.adminUser.findUniqueOrThrow({
    where: { id: userId },
    include: { memberships: { select: { tenantId: true } } },
  });
  const {
    passwordHash: _storedPasswordHash,
    externalSubject: _externalSubject,
    memberships,
    ...safe
  } = updated;
  return {
    ...safe,
    username: safe.email,
    enabled: safe.active,
    tenantIds: memberships.map(item => item.tenantId),
  };
});

app.get("/health", async (_request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [providersConfigured, activeTenants] = await Promise.all([
      prisma.providerConfig.count({ where: { enabled: true } }),
      prisma.tenant.count({ where: { active: true } }),
    ]);
    return {
      status: "ok",
      database: true,
      providersConfigured,
      activeTenants,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return reply.code(503).send({ status: "error", database: false, message: error instanceof Error ? error.message : "health failed" });
  }
});

async function handleChatwootWebhook(
  currentTenant: TenantRow,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const settings = currentTenant.settings as Record<string, unknown>;
  const configuredSecret = decrypt(typeof settings.webhookSecret === "string" ? settings.webhookSecret : undefined);
  if (!configuredSecret) return reply.code(503).send({ error: "webhook_not_configured" });
  const explicitHeader = typeof request.headers["x-webhook-secret"] === "string" ? request.headers["x-webhook-secret"] : undefined;
  const authorization = typeof request.headers.authorization === "string" && request.headers.authorization.startsWith("Bearer ")
    ? request.headers.authorization.slice(7)
    : undefined;
  const querySecret = typeof (request.query as { secret?: unknown }).secret === "string" ? (request.query as { secret: string }).secret : undefined;
  if (!matchesSecret(configuredSecret, explicitHeader ?? authorization ?? querySecret)) return reply.code(401).send({ error: "invalid_webhook_secret" });
  const parsed = webhookSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
  const body = parsed.data;
  const expectedAccount = typeof settings.chatwootAccountId === "string" ? settings.chatwootAccountId : undefined;
  const payloadAccount = body.account?.id === undefined ? undefined : String(body.account.id);
  if (expectedAccount && !payloadAccount) return reply.code(202).send({ ignored: true, reason: "account_missing" });
  if (expectedAccount && payloadAccount !== expectedAccount) return reply.code(202).send({ ignored: true, reason: "account_mismatch" });
  const expectedInboxes = new Set(configuredChatwootInboxIds(settings));
  if (!expectedInboxes.size) return reply.code(503).send({ error: "chatwoot_inboxes_not_configured" });
  const rawInbox = body.inbox?.id ?? body.conversation.inbox_id;
  const payloadInbox = rawInbox === undefined ? undefined : String(rawInbox);
  if (expectedInboxes.size && !payloadInbox) return reply.code(202).send({ ignored: true, reason: "inbox_missing" });
  if (expectedInboxes.size && payloadInbox && !expectedInboxes.has(payloadInbox)) {
    return reply.code(202).send({ ignored: true, reason: "inbox_mismatch" });
  }
  const incoming = body.message_type === "incoming" || body.message_type === 0;
  if (body.event !== "message_created" || !incoming || body.private || !body.content?.trim()) return reply.code(202).send({ ignored: true });
  const conversationId = String(body.conversation.id);
  const humanAssigned = body.conversation.meta?.assignee != null;
  const sender = body.sender ?? body.conversation.meta?.sender;
  const contactState: ConversationState = {
    ...(sender?.name?.trim() ? { nome: sender.name.trim() } : {}),
    ...(sender?.phone_number?.trim() ? { telefoneCanal: sender.phone_number.replace(/\D/g, "") } : {}),
    ...(sender?.email?.trim() ? { email: sender.email.trim().toLocaleLowerCase("pt-BR") } : {}),
  };
  void enqueue(
    currentTenant.id,
    conversationId,
    () => processMessage(
      currentTenant,
      conversationId,
      body.content!.trim(),
      body.id === undefined ? undefined : String(body.id),
      true,
      humanAssigned,
      contactState,
    ),
  ).catch(error => app.log.error(error, `chatwoot processing failed for tenant ${currentTenant.id}`));
  return reply.code(202).send({ accepted: true });
}

app.post("/webhooks/chatwoot/:tenantSlug", async (request, reply) => {
  const routingKey = String((request.params as { tenantSlug: string }).tenantSlug);
  const selected = await prisma.tenant.findFirst({
    where: {
      OR: [{ id: routingKey }, { slug: routingKey }],
      active: true,
    },
  });
  if (!selected) return reply.code(404).send({ error: "tenant_not_found" });
  return handleChatwootWebhook(selected, request, reply);
});

app.post("/webhooks/chatwoot", async (request, reply) => {
  return reply.code(410).send({
    error: "tenant_route_required",
    message: "Configure o Chatwoot com /webhooks/chatwoot/<tenant-id>; o Gateway não escolhe uma empresa padrão.",
  });
});

app.post("/v1/chat/completions", async (request, reply) => {
  const parsed = z.object({ message: z.string().min(1), conversationId: z.string().default("api-preview") }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "message_required" });
  const currentTenant = await tenant("tenant:write", request);
  try {
    return await enqueue(
      currentTenant.id,
      parsed.data.conversationId,
      () => processMessage(currentTenant, parsed.data.conversationId, parsed.data.message, undefined, false),
    );
  }
  catch (error) { request.log.error(error); return reply.code(503).send({ error: "processing_failed", message: error instanceof Error ? error.message : "erro desconhecido" }); }
});
app.post("/v1/commercial/events", async (request, reply) => {
  const parsed = commerceLinkSchema.extend({
    conversationExternalId: z.string().trim().min(1).max(500),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  if (typeof request.headers["x-tenant-id"] !== "string") {
    return reply.code(400).send({ error: "tenant_required", message: "Envie X-Tenant-Id." });
  }
  const currentTenant = await tenant("tenant:write", request);
  const { conversationExternalId, ...event } = parsed.data;
  const conversation = await conversationForTenant(currentTenant.id, conversationExternalId);
  if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
  try {
    const link = await continuousImprovement.upsertCommerceLink({
      tenantId: currentTenant.id,
      conversationId: conversation.id,
      ...event,
      metadata: event.metadata as Prisma.InputJsonValue,
      verificationEvidence: event.verificationEvidence as Prisma.InputJsonValue,
    });
    const outcome = await continuousImprovement.recalculateCommercialOutcome(currentTenant.id, conversation.id);
    const evaluation = await evaluateConversationState(currentTenant.id, conversation.id);
    return { link, outcome, evaluation };
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});

app.get("/admin/integrations/commercial-events-token", async (request) => {
  requireAdminCapability(principal(request), "tenants:write");
  const currentTenant = await tenant("tenant:write", request);
  return {
    tenantId: currentTenant.id,
    tenantName: currentTenant.name,
    token: commercialTokenForTenant(currentTenant.id),
    authorization: "Bearer <token>",
    tenantHeader: currentTenant.id,
  };
});

app.get("/admin/providers", async (request) => {
  requireProviderWriteAuthorization(principal(request));
  const rows = await providerAccess.listGlobal({ enabledOnly: false });
  return rows.map(publicProvider);
});
app.get("/admin/providers/health", async (request) => {
  requireProviderWriteAuthorization(principal(request));
  const rows = await providerAccess.listGlobal({ enabledOnly: false });
  const providers = await Promise.all(rows.map(async (row) => {
    if (!row.enabled) return { id: row.id, provider: row.name, enabled: false, healthy: null };
    const started = Date.now();
    try {
      const healthy = await instantiateProvider(row).health();
      return { id: row.id, provider: row.name, enabled: true, healthy, latencyMs: Date.now() - started };
    } catch (error) {
      return { id: row.id, provider: row.name, enabled: true, healthy: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : "provider_failed" };
    }
  }));
  return { providers, testedAt: new Date().toISOString() };
});
app.post("/admin/providers", async (request, reply) => {
  requireProviderWriteAuthorization(principal(request));
  const parsed = providerSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const scope = parsed.data.scopeMode ?? parsed.data.scope ?? ProviderScope.ALL;
  const { apiKey, scope: _scope, scopeMode: _scopeMode, tenantIds, ...value } = parsed.data;
  let row: ProviderRow | undefined;
  try {
    await validateProviderScope(scope, tenantIds);
    row = await prisma.providerConfig.create({
      data: {
        tenantId: null,
        ...value,
        scope,
        encryptedApiKey: encrypt(apiKey),
      },
    });
    const scoped = await providerAccess.setScope({
      providerConfigId: row.id,
      scope,
      tenantIds,
    });
    return reply.code(201).send(publicProvider(scoped));
  } catch (error) {
    if (row) await prisma.providerConfig.delete({ where: { id: row.id } }).catch(() => undefined);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return reply.code(409).send({ error: "provider_name_already_exists" });
    return sendAccessError(reply, error);
  }
});
app.put("/admin/providers/:key", async (request, reply) => {
  requireProviderWriteAuthorization(principal(request));
  const parsed = providerSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const existing = await providerByKey(String((request.params as { key: string }).key));
  if (!existing) return reply.code(404).send({ error: "not_found" });
  if (existing.type !== parsed.data.type) return reply.code(400).send({ error: "provider_type_mismatch" });
  const scope = parsed.data.scopeMode ?? parsed.data.scope ?? ProviderScope.ALL;
  const { apiKey, scope: _scope, scopeMode: _scopeMode, tenantIds, ...value } = parsed.data;
  try {
    await validateProviderScope(scope, tenantIds);
    await prisma.providerConfig.update({
      where: { id: existing.id },
      data: { ...value, encryptedApiKey: apiKey === undefined ? undefined : encrypt(apiKey) },
    });
    return publicProvider(await providerAccess.setScope({
      providerConfigId: existing.id,
      scope,
      tenantIds,
    }));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return reply.code(409).send({ error: "provider_name_already_exists" });
    return sendAccessError(reply, error);
  }
});
app.delete("/admin/providers/:id", async (request, reply) => {
  requireProviderWriteAuthorization(principal(request));
  const result = await prisma.providerConfig.deleteMany({ where: { id: String((request.params as { id: string }).id) } });
  return result.count ? { deleted: result.count } : reply.code(404).send({ error: "not_found" });
});
app.post("/admin/providers/:key/test", async (request, reply) => {
  requireProviderWriteAuthorization(principal(request));
  const row = await providerByKey(String((request.params as { key: string }).key));
  if (!row) return reply.code(404).send({ error: "not_found" });
  try {
    const provider = instantiateProvider(row);
    const started = Date.now();
    const healthy = await provider.health();
    return healthy ? { healthy: true, latencyMs: Date.now() - started } : reply.code(503).send({ healthy: false, latencyMs: Date.now() - started, error: "Provider ou modelo indisponível" });
  } catch (error) { return reply.code(400).send({ healthy: false, error: error instanceof Error ? error.message : "erro desconhecido" }); }
});

app.get("/admin/settings", async (request) => {
  return safeTenantSettings((await tenant("tenant:read", request)).settings);
});
app.put("/admin/settings", async (request, reply) => {
  const parsed = settingsSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const updated = await saveTenantSettings(await tenant("tenant:write", request), parsed.data);
  return { saved: true, settings: safeTenantSettings(updated.settings) };
});
app.get("/admin/branding", async (request) => safeTenantSettings((await tenant("tenant:read", request)).settings));
app.put("/admin/branding", async (request, reply) => {
  const parsed = settingsSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const updated = await saveTenantSettings(await tenant("tenant:write", request), parsed.data);
  return { saved: true, settings: safeTenantSettings(updated.settings) };
});

app.get("/admin/business-rules", async (request) => {
  const settings = (await tenant("tenant:read", request)).settings as Record<string, unknown>;
  return {
    configured: settings.businessRulesDocument !== undefined && settings.businessRulesDocument !== null,
    enabled: settings.businessRulesEnabled === true,
    rules: settings.businessRulesDocument ?? null,
  };
});

app.put("/admin/business-rules", async (request, reply) => {
  const parsed = z.object({
    rules: z.unknown().refine(value => value !== undefined, "rules_required"),
    enabled: z.boolean().default(true),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  try {
    const formatted = businessRulesFromDocument(parsed.data.rules);
    const updated = await saveTenantSettings(
      await tenant("tenant:write", request),
      {
        businessRulesDocument: parsed.data.rules,
        businessRulesEnabled: parsed.data.enabled,
      },
    );
    return {
      saved: true,
      enabled: parsed.data.enabled,
      summary: formatted.slice(0, 1_000),
      settings: safeTenantSettings(updated.settings),
    };
  } catch (error) {
    return reply.code(400).send({
      error: "invalid_business_rules",
      message: error instanceof Error ? error.message : "Documento inválido.",
    });
  }
});

app.delete("/admin/business-rules", async (request) => {
  const updated = await saveTenantSettings(
    await tenant("tenant:write", request),
    {
      businessRulesDocument: null,
      businessRulesEnabled: false,
    },
  );
  return { deleted: true, settings: safeTenantSettings(updated.settings) };
});

app.get("/admin/setup", async (request) => {
  const currentTenant = await tenant("tenant:read", request);
  const settings = currentTenant.settings as Record<string, unknown>;
  const detected = await access(quickRepliesPath).then(() => true).catch(() => false);
  const databaseHealthy = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  const alreadyImported = await prisma.knowledgeDocument.count({ where: { tenantId: currentTenant.id, source: "respostas_rapidas.xlsx" } }) > 0;
  const providers = (await providerAccess.listForTenant(currentTenant.id)).length;
  const completed = typeof settings.setupCompletedAt === "string";
  const deferred = !completed && typeof settings.setupDeferredAt === "string";
  return {
    completed: completed || deferred,
    firstRun: !completed && !deferred,
    deferred,
    quickReplies: { detected, path: quickRepliesPath, alreadyImported },
    infrastructure: {
      database: databaseHealthy,
      providersConfigured: providers,
      chatwootConfigured: Boolean(
        settings.chatwootUrl
        && settings.chatwootAccountId
        && settings.chatwootApiToken
        && configuredChatwootInboxIds(settings).length,
      ),
      chatwoot: settings.chatwootHealth ?? false,
    },
  };
});
app.post("/admin/setup/test", async (request) => {
  const currentTenant = await tenant("tenant:write", request);
  const database = { healthy: false, error: undefined as string | undefined };
  try { await prisma.$queryRaw`SELECT 1`; database.healthy = true; }
  catch (error) { database.error = error instanceof Error ? error.message : "database_failed"; }

  let providerChecks: Array<{ id: string; name: string; healthy: boolean; error?: string }> = [];
  try {
    const rows = await providerAccess.listForTenant(currentTenant.id);
    providerChecks = await Promise.all(rows.map(async (row) => {
      try { return { id: row.id, name: row.name, healthy: await instantiateProvider(row).health() }; }
      catch (error) { return { id: row.id, name: row.name, healthy: false, error: error instanceof Error ? error.message : "provider_failed" }; }
    }));
  } catch (error) {
    providerChecks = [{ id: "configuration", name: "configuration", healthy: false, error: error instanceof Error ? error.message : "provider_failed" }];
  }

  const settings = database.healthy ? currentTenant.settings as Record<string, unknown> : {};
  let chatwootCheck: { configured: boolean; healthy: boolean; latencyMs?: number; error?: string } = {
    configured: Boolean(
      settings.chatwootUrl
      && settings.chatwootAccountId
      && settings.chatwootApiToken
      && configuredChatwootInboxIds(settings).length
    ),
    healthy: false,
  };
  if (chatwootCheck.configured) {
    const started = Date.now();
    try {
      const result = await testChatwootIntegration(settings, currentTenant);
      chatwootCheck = { configured: true, healthy: true, latencyMs: Date.now() - started, ...result } as typeof chatwootCheck;
    }
    catch (error) { chatwootCheck = { configured: true, healthy: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : "chatwoot_failed" }; }
  }
  if (database.healthy) {
    const persistedHealth = {
      configured: chatwootCheck.configured,
      healthy: chatwootCheck.healthy,
      ...(chatwootCheck.latencyMs === undefined ? {} : { latencyMs: chatwootCheck.latencyMs }),
      ...(chatwootCheck.error ? { error: chatwootCheck.error } : {}),
      testedAt: new Date().toISOString(),
    };
    const merged = mergeTenantSettings(currentTenant.settings, { chatwootHealth: persistedHealth });
    await prisma.tenant.update({ where: { id: currentTenant.id }, data: { settings: merged as Prisma.InputJsonObject } });
  }
  const healthy = database.healthy && providerChecks.length > 0 && providerChecks.every((check) => check.healthy) && chatwootCheck.healthy;
  return { healthy, database, providers: providerChecks, chatwoot: chatwootCheck, testedAt: new Date().toISOString() };
});
app.post("/admin/setup/complete", async (request, reply) => {
  const parsed = setupSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const { importQuickReplies: shouldImport, provider, ...submittedSettings } = parsed.data;
  let currentTenant = await saveTenantSettings(await tenant("tenant:write", request), submittedSettings);
  if (provider) {
    requireProviderWriteAuthorization(principal(request));
    const scope = provider.scopeMode ?? provider.scope ?? ProviderScope.ALL;
    const { apiKey, scope: _scope, scopeMode: _scopeMode, tenantIds, ...value } = provider;
    await validateProviderScope(scope, tenantIds);
    const existing = await prisma.providerConfig.findFirst({ where: { name: provider.name } });
    const saved = existing
      ? await prisma.providerConfig.update({
        where: { id: existing.id },
        data: { ...value, encryptedApiKey: apiKey === undefined ? undefined : encrypt(apiKey) },
      })
      : await prisma.providerConfig.create({
        data: { tenantId: null, ...value, scope, encryptedApiKey: encrypt(apiKey) },
      });
    await providerAccess.setScope({ providerConfigId: saved.id, scope, tenantIds });
  }
  let imported = 0;
  if (shouldImport) {
    try {
      await access(quickRepliesPath);
      imported = await importQuickReplies(prisma, currentTenant.id, quickRepliesPath, undefined, embeddingOptionsFromSettings(currentTenant.settings));
    } catch (error) {
      return reply.code(400).send({ error: "quick_replies_import_failed", message: error instanceof Error ? error.message : "import_failed" });
    }
  }
  const finalSettings = mergeTenantSettings(currentTenant.settings, { setupCompletedAt: new Date().toISOString() });
  currentTenant = await prisma.tenant.update({ where: { id: currentTenant.id }, data: { settings: finalSettings as Prisma.InputJsonObject } });
  return { completed: true, imported, settings: safeTenantSettings(currentTenant.settings) };
});

app.post("/admin/chatwoot/test", async (_request, reply) => {
  const currentTenant = await tenant("tenant:write", _request);
  const settings = currentTenant.settings as Record<string, unknown>;
  const started = Date.now();
  try {
    const result = await testChatwootIntegration(settings, currentTenant);
    const health = { healthy: true, latencyMs: Date.now() - started, testedAt: new Date().toISOString(), webhook: result.webhook };
    const merged = mergeTenantSettings(currentTenant.settings, { chatwootHealth: health });
    await prisma.tenant.update({ where: { id: currentTenant.id }, data: { settings: merged as Prisma.InputJsonObject } });
    return { ...health, ...result };
  } catch (error) {
    const health = { healthy: false, latencyMs: Date.now() - started, testedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "connection_failed" };
    const merged = mergeTenantSettings(currentTenant.settings, { chatwootHealth: health });
    await prisma.tenant.update({ where: { id: currentTenant.id }, data: { settings: merged as Prisma.InputJsonObject } });
    return reply.code(503).send(health);
  }
});

app.get("/admin/tools", async (request) => {
  const rows = await prisma.toolConfig.findMany({ where: { tenantId: (await tenant("tenant:read", request)).id }, orderBy: { name: "asc" } });
  return { tools: rows.map(({ encryptedAuth, ...row }) => ({
    ...row,
    description: toolDefinitions.find((definition) => definition.name === row.name)?.description ?? "",
    hasAuth: Boolean(encryptedAuth),
    status: !row.enabled ? "disabled" : row.endpoint ? "configured" : "missing_endpoint",
  })) };
});
app.put("/admin/tools/:name", async (request, reply) => {
  const name = String((request.params as { name: string }).name);
  if (!toolDefinitions.some((definition) => definition.name === name)) return reply.code(404).send({ error: "unknown_tool" });
  const parsed = toolSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  if (parsed.data.enabled && !parsed.data.endpoint) return reply.code(400).send({ error: "endpoint_required" });
  const currentTenant = await tenant("tenant:write", request);
  const existing = await prisma.toolConfig.findUnique({ where: { tenantId_name: { tenantId: currentTenant.id, name } } });
  const submittedAuth = parsed.data.auth;
  const row = await prisma.toolConfig.upsert({
    where: { tenantId_name: { tenantId: currentTenant.id, name } },
    update: {
      enabled: parsed.data.enabled,
      endpoint: parsed.data.endpoint,
      timeoutMs: parsed.data.timeoutMs,
      encryptedAuth: submittedAuth === undefined ? existing?.encryptedAuth : submittedAuth === null || submittedAuth.type === "none" ? null : encrypt(JSON.stringify(submittedAuth)),
    },
    create: {
      tenantId: currentTenant.id,
      name,
      enabled: parsed.data.enabled,
      endpoint: parsed.data.endpoint,
      timeoutMs: parsed.data.timeoutMs,
      encryptedAuth: submittedAuth && submittedAuth.type !== "none" ? encrypt(JSON.stringify(submittedAuth)) : null,
    },
  });
  const { encryptedAuth, ...safe } = row;
  return { ...safe, hasAuth: Boolean(encryptedAuth) };
});
app.post("/admin/tools/:name/test", async (request, reply) => {
  const name = String((request.params as { name: string }).name);
  const row = await prisma.toolConfig.findUnique({ where: { tenantId_name: { tenantId: (await tenant("tenant:write", request)).id, name } } });
  if (!row) return reply.code(404).send({ error: "not_found" });
  if (!row.endpoint) return reply.code(400).send({ healthy: false, error: "endpoint_required" });
  const result = await testHttpTool({ name, endpoint: row.endpoint, timeoutMs: row.timeoutMs, auth: decodeToolAuth(row.encryptedAuth) });
  return result.healthy ? result : reply.code(503).send(result);
});

app.get("/admin/catalog-sync", async (request) => {
  const currentTenant = await tenant("tenant:read", request);
  const config = await prisma.catalogSyncConfig.findUnique({ where: { tenantId: currentTenant.id } });
  if (!config) return { configured: false, enabled: false, intervalMinutes: 240, itemsPath: "items", timeoutMs: 20_000, hasAuth: false };
  const { encryptedAuth, sourceUrl, ...safe } = config;
  return { configured: Boolean(sourceUrl), ...safe, hasAuth: Boolean(encryptedAuth) };
});

app.put("/admin/catalog-sync", async (request, reply) => {
  const parsed = catalogSyncSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  if (parsed.data.enabled && !parsed.data.sourceUrl) return reply.code(400).send({ error: "source_url_required" });
  const currentTenant = await tenant("tenant:write", request);
  const existing = await prisma.catalogSyncConfig.findUnique({ where: { tenantId: currentTenant.id } });
  const submittedAuth = parsed.data.auth;
  const config = await prisma.catalogSyncConfig.upsert({
    where: { tenantId: currentTenant.id },
    update: {
      enabled: parsed.data.enabled,
      intervalMinutes: parsed.data.intervalMinutes,
      sourceUrl: parsed.data.sourceUrl,
      itemsPath: parsed.data.itemsPath,
      timeoutMs: parsed.data.timeoutMs,
      encryptedAuth: submittedAuth === undefined ? existing?.encryptedAuth : submittedAuth === null || submittedAuth.type === "none" ? null : encrypt(JSON.stringify(submittedAuth)),
    },
    create: {
      tenantId: currentTenant.id,
      enabled: parsed.data.enabled,
      intervalMinutes: parsed.data.intervalMinutes,
      sourceUrl: parsed.data.sourceUrl,
      itemsPath: parsed.data.itemsPath,
      timeoutMs: parsed.data.timeoutMs,
      encryptedAuth: submittedAuth && submittedAuth.type !== "none" ? encrypt(JSON.stringify(submittedAuth)) : null,
    },
  });
  const { encryptedAuth, ...safe } = config;
  return { configured: Boolean(config.sourceUrl), ...safe, hasAuth: Boolean(encryptedAuth) };
});

app.post("/admin/catalog-sync/run", async (request, reply) => {
  const currentTenant = await tenant("tenant:write", request);
  const config = await prisma.catalogSyncConfig.findUnique({ where: { tenantId: currentTenant.id } });
  if (!config?.sourceUrl) return reply.code(400).send({ error: "catalog_source_not_configured" });
  const outcome = await synchronizeCatalog(prisma, config, decodeToolAuth(config.encryptedAuth), embeddingOptionsFromSettings(currentTenant.settings));
  return outcome.ok ? outcome : reply.code(502).send(outcome);
});

app.post("/internal/catalog-sync/run-due", async (request, reply) => {
  const expected = String(process.env.CATALOG_SYNC_TRIGGER_TOKEN ?? "");
  const supplied = String(request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
  if (!expected || expected.length < 24 || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const result = await runDueCatalogSyncs(prisma, decodeToolAuth, embeddingOptionsFromSettings);
  return result;
});
app.get("/admin/logs", async (request) => {
  const limit = z.coerce.number().int().min(1).max(500).catch(100).parse((request.query as { limit?: string }).limit);
  return prisma.aiLog.findMany({ where: { tenantId: (await tenant("tenant:read", request)).id }, orderBy: { createdAt: "desc" }, take: limit });
});
app.get("/admin/conversations", async (request) => {
  const conversations = await prisma.conversation.findMany({
    where: { tenantId: (await tenant("tenant:read", request)).id },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const providerMessages = await prisma.conversationMessage.findMany({
    where: { conversationId: { in: conversations.map(conversation => conversation.id) }, role: "assistant", provider: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { conversationId: true, provider: true },
  });
  const lastProvider = new Map<string, string>();
  for (const message of providerMessages) {
    if (message.provider && !lastProvider.has(message.conversationId)) lastProvider.set(message.conversationId, message.provider);
  }
  return conversations.map(conversation => ({ ...conversation, lastProvider: lastProvider.get(conversation.id) }));
});
app.get("/admin/improvement/summary", async (request) => {
  const currentTenant = await tenant("tenant:read", request);
  const [
    conversations,
    conversationCount,
    outcomeRows,
    datasets,
    evaluations,
    evaluationMetrics,
    prompt,
    feedbackCount,
    semanticCache,
  ] = await Promise.all([
    prisma.conversation.findMany({
      where: { tenantId: currentTenant.id },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 4,
          select: {
            id: true,
            role: true,
            content: true,
            provider: true,
            promptVersionId: true,
            createdAt: true,
          },
        },
        commercialOutcomes: { orderBy: { revision: "desc" }, take: 1 },
        commerceLinks: { orderBy: { updatedAt: "desc" }, take: 20 },
        humanFeedback: { orderBy: { createdAt: "desc" }, take: 10 },
        automaticEvaluations: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    prisma.conversation.count({ where: { tenantId: currentTenant.id } }),
    prisma.$queryRaw<Array<{ status: string; count: number }>>(Prisma.sql`
      SELECT latest.status::text AS status, COUNT(*)::integer AS count
      FROM (
        SELECT DISTINCT ON ("conversationId") "conversationId", status
        FROM "CommercialOutcome"
        WHERE "tenantId" = ${currentTenant.id}
        ORDER BY "conversationId", revision DESC
      ) AS latest
      GROUP BY latest.status
    `),
    prisma.evaluationDataset.findMany({
      where: { tenantId: currentTenant.id },
      orderBy: { updatedAt: "desc" },
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 20,
          include: { _count: { select: { examples: true } } },
        },
      },
    }),
    prisma.automaticEvaluation.findMany({
      where: { tenantId: currentTenant.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { conversation: { select: { externalId: true } } },
    }),
    prisma.automaticEvaluation.aggregate({
      where: { tenantId: currentTenant.id, status: "COMPLETED" },
      _count: { _all: true },
      _avg: { overallScore: true },
    }),
    prisma.promptDefinition.findUnique({
      where: {
        tenantId_name: {
          tenantId: currentTenant.id,
          name: continuousImprovementConstants.assistantPromptName,
        },
      },
      include: {
        versions: { orderBy: { version: "desc" }, take: 50 },
        releases: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: {
            primaryVersion: { select: { id: true, version: true } },
            canaryVersion: { select: { id: true, version: true } },
          },
        },
        comparisons: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: {
            baseVersion: { select: { id: true, version: true } },
            candidateVersion: { select: { id: true, version: true } },
          },
        },
      },
    }),
    prisma.humanFeedback.count({ where: { tenantId: currentTenant.id } }),
    prisma.semanticCacheEntry.aggregate({
      where: { tenantId: currentTenant.id, expiresAt: { gt: new Date() } },
      _count: true,
      _sum: { hitCount: true },
    }),
  ]);
  const classifiedOutcomeCount = outcomeRows.reduce((total, row) => total + row.count, 0);
  const outcomeCounts = {
    PENDING: (outcomeRows.find(row => row.status === CommercialOutcomeStatus.PENDING)?.count ?? 0)
      + Math.max(0, conversationCount - classifiedOutcomeCount),
    WON: outcomeRows.find(row => row.status === CommercialOutcomeStatus.WON)?.count ?? 0,
    LOST: outcomeRows.find(row => row.status === CommercialOutcomeStatus.LOST)?.count ?? 0,
  };
  return {
    metrics: {
      conversations: conversationCount,
      outcomes: outcomeCounts,
      feedback: feedbackCount,
      evaluations: evaluationMetrics._count._all,
      averageEvaluation: evaluationMetrics._avg.overallScore === null
        ? null
        : Number(evaluationMetrics._avg.overallScore),
      semanticCache: {
        entries: semanticCache._count,
        hits: semanticCache._sum.hitCount ?? 0,
      },
    },
    conversations,
    datasets,
    evaluations,
    prompt: prompt ? {
      definition: { id: prompt.id, name: prompt.name, description: prompt.description },
      versions: prompt.versions,
      releases: prompt.releases,
      comparisons: prompt.comparisons,
    } : null,
  };
});
app.get("/admin/learning/candidates", async (request) => {
  const currentTenant = await tenant("tenant:read", request);
  const parsed = z.object({
    includeBlocked: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }).parse(request.query ?? {});
  const [reviewQueue, approvedGuidance] = await Promise.all([
    learningCandidates.listReviewQueue({
      tenantId: currentTenant.id,
      includeBlocked: parsed.includeBlocked !== "false",
      limit: parsed.limit,
    }),
    learningCandidates.listApprovedGuidance(currentTenant.id),
  ]);
  return { reviewQueue, approvedGuidance };
});
app.post("/admin/learning/discover", async (request, reply) => {
  const parsed = learningDiscoverySchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  try {
    return await learningCandidates.discoverFromEvaluations({
      tenantId: currentTenant.id,
      ...parsed.data,
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/learning/candidates/review", async (request, reply) => {
  const parsed = learningReviewSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  try {
    return await learningCandidates.reviewCandidates({
      tenantId: currentTenant.id,
      candidateIds: parsed.data.candidateIds,
      decision: parsed.data.decision,
      reviewerId: principal(request).userId,
      note: parsed.data.note,
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/learning/candidates/:id/ground", async (request, reply) => {
  const parsed = z.object({
    references: z.array(learningGroundingReferenceSchema).min(1).max(20),
    note: z.string().max(5_000).nullable().optional(),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  try {
    return await learningCandidates.groundCandidate({
      tenantId: currentTenant.id,
      candidateId: String((request.params as { id: string }).id),
      references: parsed.data.references,
      verifiedBy: principal(request).userId,
      note: parsed.data.note,
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.put("/admin/conversations/:externalId/outcome", async (request, reply) => {
  const parsed = improvementOutcomeSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  const externalId = String((request.params as { externalId: string }).externalId);
  const conversation = await conversationForTenant(currentTenant.id, externalId);
  if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
  try {
    const outcome = await continuousImprovement.recordCommercialOutcome({
      tenantId: currentTenant.id,
      conversationId: conversation.id,
      ...parsed.data,
      evidence: parsed.data.evidence as Prisma.InputJsonValue,
      createdBy: principal(request).userId,
    });
    const evaluation = await evaluateConversationState(currentTenant.id, conversation.id);
    return { outcome, evaluation };
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/conversations/:externalId/commerce-links", async (request, reply) => {
  const parsed = commerceLinkSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  const externalId = String((request.params as { externalId: string }).externalId);
  const conversation = await conversationForTenant(currentTenant.id, externalId);
  if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
  try {
    const link = await continuousImprovement.upsertCommerceLink({
      tenantId: currentTenant.id,
      conversationId: conversation.id,
      ...parsed.data,
      metadata: parsed.data.metadata as Prisma.InputJsonValue,
      verificationEvidence: parsed.data.verificationEvidence as Prisma.InputJsonValue,
    });
    const outcome = await continuousImprovement.recalculateCommercialOutcome(currentTenant.id, conversation.id);
    const evaluation = await evaluateConversationState(currentTenant.id, conversation.id);
    return { link, outcome, evaluation };
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/conversations/:externalId/feedback", async (request, reply) => {
  const parsed = humanFeedbackSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  const externalId = String((request.params as { externalId: string }).externalId);
  const conversation = await conversationForTenant(currentTenant.id, externalId);
  if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
  try {
    const feedback = await continuousImprovement.recordHumanFeedback({
      tenantId: currentTenant.id,
      conversationId: conversation.id,
      ...parsed.data,
      reviewerId: principal(request).userId,
      metadata: parsed.data.metadata as Prisma.InputJsonValue,
    });
    const evaluation = await evaluateConversationState(currentTenant.id, conversation.id);
    return { feedback, evaluation };
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/conversations/:externalId/evaluate", async (request, reply) => {
  const currentTenant = await tenant("tenant:write", request);
  const externalId = String((request.params as { externalId: string }).externalId);
  const conversation = await conversationForTenant(currentTenant.id, externalId);
  if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
  try {
    return await evaluateConversationState(currentTenant.id, conversation.id);
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/datasets/materialize", async (request, reply) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(2_000).nullable().optional(),
    notes: z.string().max(5_000).nullable().optional(),
    createdBy: z.string().trim().min(1).max(200).default("admin"),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  try {
    const dataset = await continuousImprovement.ensureDataset(
      currentTenant.id,
      parsed.data.name,
      parsed.data.description,
    );
    const version = await continuousImprovement.createDatasetDraft({
      tenantId: currentTenant.id,
      datasetId: dataset.id,
      createdBy: principal(request).userId,
      notes: parsed.data.notes,
    });
    const [feedback, evaluations] = await Promise.all([
      prisma.humanFeedback.findMany({
        where: {
          tenantId: currentTenant.id,
          verdict: {
            in: [HumanFeedbackVerdict.POSITIVE, HumanFeedbackVerdict.NEGATIVE],
          },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }),
      prisma.automaticEvaluation.findMany({
        where: { tenantId: currentTenant.id, status: "COMPLETED" },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }),
    ]);
    let feedbackExamples = 0;
    let evaluationExamples = 0;
    const skipped: Array<{ source: string; id: string; reason: string }> = [];
    for (const item of feedback) {
      try {
        await continuousImprovement.materializeFeedbackExample({
          tenantId: currentTenant.id,
          feedbackId: item.id,
          datasetVersionId: version.id,
        });
        feedbackExamples += 1;
      } catch (error) {
        skipped.push({
          source: "feedback",
          id: item.id,
          reason: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }
    for (const item of evaluations) {
      try {
        await continuousImprovement.materializeEvaluationExample({
          tenantId: currentTenant.id,
          evaluationId: item.id,
          datasetVersionId: version.id,
        });
        evaluationExamples += 1;
      } catch (error) {
        skipped.push({
          source: "evaluation",
          id: item.id,
          reason: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }
    const refreshed = await prisma.datasetVersion.findUniqueOrThrow({
      where: { id: version.id },
      include: { _count: { select: { examples: true } } },
    });
    return {
      dataset,
      version: refreshed,
      materialized: { feedback: feedbackExamples, evaluations: evaluationExamples },
      skipped,
    };
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/datasets/:datasetId/versions/:versionId/publish", async (request, reply) => {
  const parsed = z.object({
    publishedBy: z.string().trim().min(1).max(200).default("admin"),
  }).safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  const { datasetId, versionId } = request.params as { datasetId: string; versionId: string };
  const version = await prisma.datasetVersion.findFirst({
    where: { id: versionId, datasetId, tenantId: currentTenant.id },
    select: { id: true },
  });
  if (!version) return reply.code(404).send({ error: "dataset_version_not_found" });
  try {
    return await continuousImprovement.publishDatasetVersion({
      tenantId: currentTenant.id,
      datasetVersionId: version.id,
      publishedBy: principal(request).userId,
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.get("/admin/prompts", async (request) => {
  const currentTenant = await tenant("tenant:read", request);
  const definition = await prisma.promptDefinition.findUnique({
    where: {
      tenantId_name: {
        tenantId: currentTenant.id,
        name: continuousImprovementConstants.assistantPromptName,
      },
    },
    include: {
      versions: { orderBy: { version: "desc" } },
      releases: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          primaryVersion: { select: { id: true, version: true, content: true } },
          canaryVersion: { select: { id: true, version: true } },
        },
      },
      comparisons: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          baseVersion: { select: { id: true, version: true } },
          candidateVersion: { select: { id: true, version: true } },
        },
      },
    },
  });
  const identity = promptSettings(currentTenant.settings);
  const settingsBundle = {
    system: identity.system,
    commercial: identity.commercial,
    support: identity.support,
    postSale: identity.postSale,
  };
  const activeRelease = definition?.releases.find(release => release.status === "ACTIVE");
  const activeBundle = activeRelease?.primaryVersion.content
    ? parsePromptBundle(activeRelease.primaryVersion.content)
    : null;
  return {
    definition: definition ? { id: definition.id, name: definition.name, description: definition.description } : null,
    versions: definition?.versions ?? [],
    releases: definition?.releases ?? [],
    comparisons: definition?.comparisons ?? [],
    currentBundle: activeBundle ?? settingsBundle,
    settingsBundle,
    activeReleaseId: activeRelease?.id ?? null,
  };
});
app.post("/admin/prompts/versions", async (request, reply) => {
  const parsed = promptVersionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  let content = parsed.data.content;
  if (typeof content === "string") {
    try {
      JSON.parse(content);
    } catch {
      const identity = promptSettings(currentTenant.settings);
      content = serializePromptBundle({
        system: content,
        commercial: identity.commercial,
        support: identity.support,
        postSale: identity.postSale,
      });
    }
  }
  try {
    return await continuousImprovement.createPromptVersion({
      tenantId: currentTenant.id,
      promptName: parsed.data.definitionName,
      description: parsed.data.description,
      content,
      createdBy: principal(request).userId,
      metadata: parsed.data.description ? { description: parsed.data.description } : {},
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/prompts/versions/:id/approve", async (request, reply) => {
  const parsed = z.object({
    approvedBy: z.string().trim().min(1).max(200).default("admin"),
  }).safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  try {
    return await continuousImprovement.approvePromptVersion({
      tenantId: (await tenant("tenant:write", request)).id,
      promptVersionId: String((request.params as { id: string }).id),
      approvedBy: principal(request).userId,
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/prompts/compare", async (request, reply) => {
  const parsed = z.object({
    baseVersionId: z.string().trim().min(1),
    candidateVersionId: z.string().trim().min(1),
    createdBy: z.string().trim().min(1).max(200).default("admin"),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  try {
    const comparison = await continuousImprovement.comparePromptVersions({
      tenantId: currentTenant.id,
      ...parsed.data,
      createdBy: principal(request).userId,
    });
    const [baseMetrics, candidateMetrics] = await Promise.all([
      prisma.automaticEvaluation.aggregate({
        where: {
          tenantId: currentTenant.id,
          promptVersionId: parsed.data.baseVersionId,
          status: "COMPLETED",
        },
        _avg: { overallScore: true },
        _count: { _all: true },
      }),
      prisma.automaticEvaluation.aggregate({
        where: {
          tenantId: currentTenant.id,
          promptVersionId: parsed.data.candidateVersionId,
          status: "COMPLETED",
        },
        _avg: { overallScore: true },
        _count: { _all: true },
      }),
    ]);
    const metrics = {
      base: {
        evaluations: baseMetrics._count._all,
        averageScore: baseMetrics._avg.overallScore === null ? null : Number(baseMetrics._avg.overallScore),
      },
      candidate: {
        evaluations: candidateMetrics._count._all,
        averageScore: candidateMetrics._avg.overallScore === null ? null : Number(candidateMetrics._avg.overallScore),
      },
    };
    return prisma.promptComparison.update({
      where: { id: comparison.id },
      data: { metrics },
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/prompts/release", async (request, reply) => {
  const parsed = z.object({
    definitionName: z.string().trim().min(1).max(160).default(continuousImprovementConstants.assistantPromptName),
    primaryVersionId: z.string().trim().min(1),
    canaryVersionId: z.string().trim().min(1).nullable().optional(),
    canaryPercent: z.number().int().min(0).max(99).optional(),
    kind: z.enum(["ACTIVE", "CANARY"]).default("ACTIVE"),
    reason: z.string().max(5_000).nullable().optional(),
    createdBy: z.string().trim().min(1).max(200).default("admin"),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  if (
    parsed.data.kind === "CANARY"
    && (!parsed.data.canaryVersionId || !parsed.data.canaryPercent || parsed.data.canaryPercent < 1)
  ) {
    return reply.code(400).send({
      error: "invalid_canary",
      message: "Release canário exige versão candidata e percentual entre 1 e 99.",
    });
  }
  try {
    return await continuousImprovement.deployPrompt({
      tenantId: (await tenant("tenant:write", request)).id,
      promptName: parsed.data.definitionName,
      primaryVersionId: parsed.data.primaryVersionId,
      canaryVersionId: parsed.data.kind === "CANARY" ? parsed.data.canaryVersionId : null,
      canaryPercent: parsed.data.kind === "CANARY" ? parsed.data.canaryPercent : 0,
      reason: parsed.data.reason,
      createdBy: principal(request).userId,
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/prompts/promote", async (request, reply) => {
  const parsed = z.object({
    definitionName: z.string().trim().min(1).max(160).default(continuousImprovementConstants.assistantPromptName),
    reason: z.string().max(5_000).nullable().optional(),
    createdBy: z.string().trim().min(1).max(200).default("admin"),
  }).safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  try {
    return await continuousImprovement.promoteCanary({
      tenantId: (await tenant("tenant:write", request)).id,
      promptName: parsed.data.definitionName,
      reason: parsed.data.reason,
      createdBy: principal(request).userId,
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.post("/admin/prompts/rollback", async (request, reply) => {
  const parsed = z.object({
    definitionName: z.string().trim().min(1).max(160).default(continuousImprovementConstants.assistantPromptName),
    targetVersionId: z.string().trim().min(1).nullable().optional(),
    reason: z.string().max(5_000).default("rollback manual pelo painel"),
    createdBy: z.string().trim().min(1).max(200).default("admin"),
  }).safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  try {
    return await continuousImprovement.rollbackPrompt({
      tenantId: (await tenant("tenant:write", request)).id,
      promptName: parsed.data.definitionName,
      targetVersionId: parsed.data.targetVersionId,
      reason: parsed.data.reason,
      createdBy: principal(request).userId,
    });
  } catch (error) {
    return sendImprovementError(reply, error);
  }
});
app.get("/admin/rag/documents", async (request) => ({ documents: await listRagDocuments(prisma, (await tenant("tenant:read", request)).id) }));
app.get("/admin/rag/documents/:source/:externalId", async (request, reply) => {
  const { source, externalId } = request.params as { source: string; externalId: string };
  const document = await getRagDocument(prisma, (await tenant("tenant:read", request)).id, source, externalId);
  return document ?? reply.code(404).send({ error: "not_found" });
});
app.put("/admin/rag/documents/:source/:externalId", async (request, reply) => {
  const { source, externalId } = request.params as { source: string; externalId: string };
  const parsed = z.object({ chunks: z.array(z.object({ id: z.string().min(1), content: z.string().trim().min(1).max(100_000) })).min(1).max(2_000) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  try {
    const updated = await updateRagDocument(prisma, currentTenant.id, source, externalId, parsed.data.chunks, embeddingOptionsFromSettings(currentTenant.settings));
    return updated ? { updated } : reply.code(404).send({ error: "not_found" });
  } catch (error) {
    return reply.code(400).send({ error: "update_failed", message: error instanceof Error ? error.message : "unknown_error" });
  }
});
app.delete("/admin/rag/documents/:source/:externalId", async (request, reply) => {
  const { source, externalId } = request.params as { source: string; externalId: string };
  const result = await deleteRagDocument(prisma, (await tenant("tenant:write", request)).id, source, externalId);
  return result.count ? { deleted: result.count } : reply.code(404).send({ error: "not_found" });
});
app.post("/admin/rag/reindex", async (request, reply) => {
  const parsed = z.object({ source: z.string().min(1).optional(), externalId: z.string().min(1).optional() }).safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const currentTenant = await tenant("tenant:write", request);
  try {
    const reindexed = await reindexRagDocuments(prisma, currentTenant.id, parsed.data, embeddingOptionsFromSettings(currentTenant.settings));
    return { reindexed };
  } catch (error) {
    return reply.code(400).send({ error: "reindex_failed", message: error instanceof Error ? error.message : "unknown_error" });
  }
});
app.post("/admin/rag/import", async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: "file_required" });
  const extension = extname(file.filename).toLowerCase();
  if (![".xlsx", ".pdf", ".docx", ".md", ".markdown", ".txt", ".html", ".htm"].includes(extension)) return reply.code(400).send({ error: "unsupported_file" });
  const temporaryPath = join(tmpdir(), `gateway-${randomUUID()}${extension}`);
  try {
    await writeFile(temporaryPath, await file.toBuffer());
    const currentTenant = await tenant("tenant:write", request);
    const embeddingOptions = embeddingOptionsFromSettings(currentTenant.settings);
    const requestedRole = String((request.query as Record<string, unknown> | undefined)?.agentRole ?? "").trim();
    const agentRole = ["intake", "sales", "customer_care", "technical", "quality"].includes(requestedRole)
      ? requestedRole
      : undefined;
    if (extension === ".xlsx") {
      return { imported: await importQuickReplies(prisma, currentTenant.id, temporaryPath, undefined, embeddingOptions, file.filename) };
    }
    const documents = await importFile(prisma, currentTenant.id, temporaryPath, file.filename, embeddingOptions, agentRole ? { agentRole } : {});
    return { imported: documents.length };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "import_failed" }); }
  finally { await unlink(temporaryPath).catch(() => undefined); }
});

async function bootstrap() {
  const defaults = [
    {
      type: "cloudflare",
      name: "Cloudflare AI",
      enabled: false,
      priority: 1,
      model: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
      options: {
        temperature: 0.2,
        maxTokens: 600,
        timeoutMs: 5_000,
        inputCostPerMillion: 0.045,
        outputCostPerMillion: 0.384,
      },
    },
    {
      type: "openrouter",
      name: "OpenRouter",
      enabled: false,
      priority: 2,
      model: "openrouter/free",
      baseUrl: "https://openrouter.ai/api/v1",
      options: {
        temperature: 0.2,
        maxTokens: 600,
        timeoutMs: 15_000,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
      },
    },
    {
      type: "gemini",
      name: "Google Gemini",
      enabled: false,
      priority: 3,
      model: "gemini-3.5-flash-lite",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      options: {
        temperature: 0.2,
        maxTokens: 600,
        timeoutMs: 15_000,
        inputCostPerMillion: 0.3,
        outputCostPerMillion: 2.5,
      },
    },
    { type: "ollama", name: "Ollama", enabled: false, priority: 4, model: "llama3.2:3b", baseUrl: process.env.OLLAMA_URL || "http://localhost:11434" },
  ];
  for (const item of defaults) {
    await prisma.providerConfig.upsert({
      where: { name: item.name },
      update: {},
      create: {
        tenantId: null,
        scope: ProviderScope.ALL,
        ...item,
      },
    });
  }
}

await bootstrap();
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3001) });

let shutdownStarted = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  app.log.info({ signal }, "Encerramento gracioso iniciado");
  const deadline = setTimeout(() => {
    app.log.error({ signal }, "Tempo limite do encerramento gracioso excedido");
    process.exit(1);
  }, 45_000);
  deadline.unref();
  try {
    await app.close();
    await prisma.$disconnect();
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    app.log.error({ error, signal }, "Falha no encerramento gracioso");
    process.exit(1);
  }
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
