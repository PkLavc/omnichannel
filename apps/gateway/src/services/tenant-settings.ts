import type { EmbeddingOptions } from "../core/embedding.js";

export type JsonSettings = Record<string, unknown>;

export type InitialTenantSettings = {
  name: string;
  botName?: string;
  language: string;
  primaryColor: string;
  deferIntegrations?: boolean;
};

function record(value: unknown): JsonSettings {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonSettings : {};
}

/** Merge a partial admin payload without discarding sibling nested settings. */
export function mergeTenantSettings(existing: unknown, update: JsonSettings): JsonSettings {
  const current = record(existing);
  const result: JsonSettings = { ...current, ...update };
  for (const key of ["businessHours", "prompts", "embeddings"] as const) {
    if (key in update) result[key] = { ...record(current[key]), ...record(update[key]) };
  }
  return result;
}

/** Create an isolated bot profile without copying knowledge or integration settings. */
export function buildInitialTenantSettings(
  input: InitialTenantSettings,
  createdAt = new Date(),
): JsonSettings {
  return {
    companyName: input.name.trim(),
    ...(input.botName?.trim() ? { botName: input.botName.trim() } : {}),
    language: input.language.trim(),
    primaryColor: input.primaryColor,
    businessRulesEnabled: false,
    prompts: { system: "", commercial: "", support: "", postSale: "" },
    ...(input.deferIntegrations ? { setupDeferredAt: createdAt.toISOString() } : {}),
  };
}

export function embeddingOptionsFromSettings(settings: unknown): EmbeddingOptions {
  const value = record(record(settings).embeddings);
  const provider = value.provider === "ollama" ? "ollama" : "local";
  return {
    provider,
    ...(typeof value.baseUrl === "string" && value.baseUrl ? { baseUrl: value.baseUrl } : {}),
    ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
  };
}

export function safeTenantSettings(settings: unknown) {
  const { chatwootApiToken, webhookSecret, ...safe } = record(settings);
  return {
    ...safe,
    hasChatwootApiToken: typeof chatwootApiToken === "string" && chatwootApiToken.length > 0,
    hasWebhookSecret: typeof webhookSecret === "string" && webhookSecret.length > 0,
  };
}

export function promptSettings(settings: unknown) {
  const root = record(settings);
  const prompts = record(root.prompts);
  return {
    companyName: typeof root.companyName === "string" && root.companyName.trim() ? root.companyName.trim() : "a empresa",
    botName: typeof root.botName === "string" && root.botName.trim() ? root.botName.trim() : "assistente virtual",
    language: typeof root.language === "string" && root.language.trim() ? root.language.trim() : "pt-BR",
    system: typeof prompts.system === "string" ? prompts.system.trim() : "",
    commercial: typeof prompts.commercial === "string" ? prompts.commercial.trim() : "",
    support: typeof prompts.support === "string" ? prompts.support.trim() : "",
    postSale: typeof prompts.postSale === "string" ? prompts.postSale.trim() : "",
    welcomeMessage: typeof root.welcomeMessage === "string" ? root.welcomeMessage.trim() : "",
    welcomePrompt: typeof root.welcomePrompt === "string" ? root.welcomePrompt.trim() : "",
    welcomeImageFile: typeof root.welcomeImageFile === "string" ? root.welcomeImageFile.trim() : "",
    outOfHoursMessage: typeof root.outOfHoursMessage === "string" ? root.outOfHoursMessage.trim() : "",
    transferMessage: typeof root.transferMessage === "string" ? root.transferMessage.trim() : "",
  };
}
