export type ChatwootConfig = {
  url: string;
  accountId: string;
  apiToken: string;
  teamId?: number;
  assigneeId?: number;
  inboxId?: string;
  inboxIds?: string[];
};

export type ChatwootAssignment = {
  teamId?: number;
  assigneeId?: number;
};

type ChatwootAgent = { id?: number; availability_status?: string };

export class ChatwootError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryable = false) {
    super(message);
  }
}

const WEBHOOK_NAME = "AI Gateway";
// We need message events to answer, plus conversation state changes to keep the
// local learning record in sync when an agent resolves, snoozes or returns a
// conversation to automation from the Chatwoot UI.
const WEBHOOK_SUBSCRIPTIONS = [
  "message_created",
  "conversation_updated",
  "conversation_status_changed",
] as const;

type ChatwootWebhook = {
  id?: string | number;
  name?: string;
  url?: string;
  subscriptions?: unknown;
};

export type EnsureWebhookResult = {
  action: "created" | "updated";
  webhook: unknown;
};

export type ChatwootCustomAttributeDefinition = {
  key: string;
  name: string;
  description: string;
  displayType?: 0 | 1 | 4 | 5 | 6;
  values?: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function webhookList(value: unknown): ChatwootWebhook[] {
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value.webhooks, value.data].find(Array.isArray)
        ?? (Array.isArray(value.payload) ? value.payload : isRecord(value.payload) ? webhookList(value.payload) : [])
      : [];
  return candidates.filter(isRecord) as ChatwootWebhook[];
}

function normalizedWebhookUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ChatwootError("A URL do webhook do Chatwoot é inválida");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ChatwootError("A URL do webhook do Chatwoot deve usar HTTP ou HTTPS");
  }
  parsed.hash = "";
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

export class ChatwootClient {
  constructor(private readonly config: ChatwootConfig, private readonly attempts = 3) {}

  async testConnection(): Promise<{ accountId: string; inboxId?: string; inboxIds: string[] }> {
    const accountPath = `/api/v1/accounts/${encodeURIComponent(this.config.accountId)}`;
    const inboxIds = [...new Set([
      ...(this.config.inboxId ? [this.config.inboxId] : []),
      ...(this.config.inboxIds ?? []),
    ].map(value => value.trim()).filter(Boolean))];
    if (!inboxIds.length) {
      await this.request("GET", accountPath);
    } else {
      for (const inboxId of inboxIds) {
        await this.request("GET", `${accountPath}/inboxes/${encodeURIComponent(inboxId)}`);
      }
    }
    return {
      accountId: this.config.accountId,
      ...(inboxIds[0] ? { inboxId: inboxIds[0] } : {}),
      inboxIds,
    };
  }

  private async request(method: "GET" | "POST" | "PATCH", path: string, body?: object): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const response = await fetch(`${this.config.url.replace(/\/$/, "")}${path}`, {
          method,
          headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            api_access_token: this.config.apiToken,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) return response.status === 204 ? undefined : await response.json();
        const detail = (await response.text()).slice(0, 500);
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new ChatwootError(`Chatwoot HTTP ${response.status}: ${detail}`, response.status, retryable);
        if (!retryable) throw lastError;
      } catch (error) {
        lastError = error;
        if (error instanceof ChatwootError && !error.retryable) throw error;
      }
      if (attempt < this.attempts) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
    throw lastError instanceof Error ? lastError : new ChatwootError("Falha desconhecida no Chatwoot");
  }

  async sendMessage(conversationId: string, content: string): Promise<unknown> {
    return this.request(
      "POST",
      `/api/v1/accounts/${encodeURIComponent(this.config.accountId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { content, message_type: "outgoing", private: false, content_type: "text" },
    );
  }

  async updateConversationCustomAttributes(
    conversationId: string,
    customAttributes: Record<string, string>,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/v1/accounts/${encodeURIComponent(this.config.accountId)}/conversations/${encodeURIComponent(conversationId)}/custom_attributes`,
      { custom_attributes: customAttributes },
    );
  }

  async ensureConversationCustomAttributes(
    definitions: readonly ChatwootCustomAttributeDefinition[],
  ): Promise<{ created: string[]; existing: string[]; updated: string[] }> {
    const path = `/api/v1/accounts/${encodeURIComponent(this.config.accountId)}/custom_attribute_definitions`;
    const raw = await this.request("GET", `${path}?attribute_model=0`);
    const rows = Array.isArray(raw) ? raw : [];
    const existingByKey = new Map(rows.flatMap((row) =>
      isRecord(row) && typeof row.attribute_key === "string" ? [[row.attribute_key, row] as const] : [],
    ));
    const created: string[] = [];
    const existing: string[] = [];
    const updated: string[] = [];
    for (const definition of definitions) {
      const current = existingByKey.get(definition.key);
      const desiredValues = [...(definition.values ?? [])];
      const currentValues = Array.isArray(current?.attribute_values)
        ? current.attribute_values.filter((value): value is string => typeof value === "string")
        : [];
      const desiredDisplayType = definition.displayType ?? 0;
      const currentDisplayType = typeof current?.attribute_display_type === "number"
        ? current.attribute_display_type
        : ({ text: 0, number: 1, link: 4, date: 5, list: 6 } as Record<string, number>)[
          typeof current?.attribute_display_type === "string" ? current.attribute_display_type : ""
        ];
      const needsUpdate = current
        && typeof current.id === "number"
        && (currentDisplayType !== desiredDisplayType
          || JSON.stringify(currentValues) !== JSON.stringify(desiredValues));
      if (needsUpdate) {
        await this.request("PATCH", `${path}/${encodeURIComponent(String(current.id))}`, {
          attribute_display_name: definition.name,
          attribute_display_type: desiredDisplayType,
          attribute_description: definition.description,
          attribute_key: definition.key,
          attribute_values: desiredValues,
          attribute_model: 0,
        });
        updated.push(definition.key);
        continue;
      }
      if (current) {
        existing.push(definition.key);
        continue;
      }
      await this.request("POST", path, {
        attribute_display_name: definition.name,
        attribute_display_type: desiredDisplayType,
        attribute_description: definition.description,
        attribute_key: definition.key,
        attribute_values: desiredValues,
        attribute_model: 0,
      });
      created.push(definition.key);
    }
    return { created, existing, updated };
  }

  async transferToHuman(conversationId: string, override?: ChatwootAssignment): Promise<unknown> {
    const target = override ?? {
      teamId: this.config.teamId,
      assigneeId: this.config.assigneeId,
    };
    const assignment = {
      ...(target.assigneeId ? { assignee_id: target.assigneeId } : {}),
      ...(target.teamId ? { team_id: target.teamId } : {}),
    };
    if (!Object.keys(assignment).length) throw new ChatwootError("Configure teamId ou assigneeId para transferir ao atendimento humano");
    return this.request(
      "POST",
      `/api/v1/accounts/${encodeURIComponent(this.config.accountId)}/conversations/${encodeURIComponent(conversationId)}/assignments`,
      assignment,
    );
  }

  /** Checks the actual Chatwoot presence before assigning a live conversation. */
  async hasAvailableAgent(override?: ChatwootAssignment): Promise<boolean> {
    const target = override ?? { teamId: this.config.teamId, assigneeId: this.config.assigneeId };
    const accountPath = `/api/v1/accounts/${encodeURIComponent(this.config.accountId)}`;
    const raw = target.teamId
      ? await this.request("GET", `${accountPath}/teams/${encodeURIComponent(String(target.teamId))}/team_members`)
      : await this.request("GET", `${accountPath}/agents`);
    const rows = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw.payload) ? raw.payload : [];
    const agents = rows.filter(isRecord) as ChatwootAgent[];
    const candidates = target.assigneeId ? agents.filter(agent => agent.id === target.assigneeId) : agents;
    return candidates.some(agent => agent.availability_status === "available");
  }

  /** Creates the account webhook once, or reconciles an existing entry by technical name, legacy name, or URL. */
  async ensureWebhook(url: string, name = WEBHOOK_NAME, legacyNames: readonly string[] = []): Promise<EnsureWebhookResult> {
    const desiredUrl = normalizedWebhookUrl(url);
    const accountPath = `/api/v1/accounts/${encodeURIComponent(this.config.accountId)}/webhooks`;
    const acceptedNames = new Set([name, ...legacyNames]);
    const existing = webhookList(await this.request("GET", accountPath)).find((webhook) =>
      (typeof webhook.name === "string" && acceptedNames.has(webhook.name)) ||
      (typeof webhook.url === "string" && normalizedWebhookUrl(webhook.url) === desiredUrl),
    );
    const body = {
      name,
      url: desiredUrl,
      subscriptions: [...WEBHOOK_SUBSCRIPTIONS],
    };

    if (!existing) {
      return { action: "created", webhook: await this.request("POST", accountPath, body) };
    }
    if (existing.id === undefined || existing.id === null || String(existing.id).length === 0) {
      throw new ChatwootError("O webhook existente do Chatwoot não possui identificador");
    }
    return {
      action: "updated",
      webhook: await this.request("PATCH", `${accountPath}/${encodeURIComponent(String(existing.id))}`, body),
    };
  }
}
