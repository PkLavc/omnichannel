import type { ToolResult } from "../domain/types.js";

export type ToolContext = {
  tenantId?: string;
  conversationExternalId?: string;
  state?: Record<string, string>;
  signal: AbortSignal;
};

export interface Tool {
  name: string;
  matches(input: string): boolean;
  execute(input: string, context?: Partial<ToolContext>): Promise<ToolResult>;
}

export type ToolHandler = (input: string, context: ToolContext) => Promise<ToolResult>;

export type ToolDefinition = {
  name: string;
  description: string;
  patterns: RegExp[];
};

export type ToolAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apiKey" | "header"; headerName: string; value: string };

export type HttpToolConfig = {
  name: string;
  endpoint: string;
  timeoutMs: number;
  auth?: ToolAuth;
};

export class ToolExecutionError extends Error {
  constructor(public readonly toolName: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolExecutionError";
  }
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "consultarEstoque",
    description: "Consulta disponibilidade física de um produto ou peça.",
    patterns: [/\bestoque\b/i, /\b(?:tem|possui|disponibilidade)\b.{0,30}\b(?:produto|peça|peca|modelo)\b/i],
  },
  {
    name: "consultarProduto",
    description: "Consulta catálogo, modelo, especificação ou preço cadastrado de produto.",
    patterns: [/\b(?:produto|modelo|catálogo|catalogo|preço|preco)\b/i],
  },
  {
    name: "consultarGarantia",
    description: "Consulta cobertura e situação de garantia do cliente ou aparelho.",
    patterns: [/\bgarantia\b/i, /\bcobertura\b.{0,20}\b(?:aparelho|produto|reparo)\b/i],
  },
  {
    name: "consultarOS",
    description: "Consulta uma ordem de serviço existente.",
    patterns: [
      /\bordem\s+de\s+servi[cç]o\b/i,
      /(?:^|\s)os\s*(?:n[º°o.]|#|\d)/i,
      /\b(?:status|andamento|situa[cç][aã]o)\b.{0,45}\b(?:servi[cç]o|reparo|conserto|manuten[cç][aã]o|aparelho)\b/i,
      /\b(?:meu|minha)\s+(?:reparo|conserto|manuten[cç][aã]o)\b/i,
    ],
  },
  {
    name: "consultarCliente",
    description: "Consulta cadastro e histórico autorizado de cliente.",
    patterns: [
      /\b(?:meu|o)\s+cadastro\b/i,
      /\bconsult(?:ar|e)\b.{0,20}\bcliente\b/i,
      /\b(?:meus?|tenho)\s+(?:agendamentos?|atendimentos?)\b/i,
    ],
  },
  {
    name: "agendamento",
    description: "Consulta horários disponíveis para atendimento.",
    patterns: [
      /\b(?:agendar|agendamento|remarcar|agenda)\b/i,
      /\bhor[aá]rios?\s+dispon[ií]ve(?:l|is)\b/i,
      /\b(?:quais?\s+)?hor[aá]rios?\s+(?:tem|h[aá]|existem?)\b/i,
      /\b(?:hoje|amanh[aã])\b.{0,30}\b(?:[01]?\d|2[0-3])(?:[:h]\d{0,2}|\s+horas?)\b/i,
      /\b(?:[01]?\d|2[0-3])(?:[:h]\d{0,2}|\s+horas?)\b.{0,30}\b(?:hoje|amanh[aã])\b/i,
      /\bdisponibilidade\b.{0,30}\b(?:atendimento|agenda|hor[aá]rio)\b/i,
    ],
  },
];

function normalizeInput(input: string) {
  return input.normalize("NFKC").trim();
}

function validateResult(toolName: string, value: ToolResult): ToolResult {
  if (!value || typeof value !== "object") {
    throw new ToolExecutionError(toolName, "A Tool retornou um valor inválido");
  }
  if (typeof value.found !== "boolean") {
    throw new ToolExecutionError(toolName, "A Tool não informou se encontrou resultado");
  }
  if (typeof value.content !== "string" || !value.content.trim()) {
    throw new ToolExecutionError(toolName, "A Tool retornou conteúdo vazio");
  }
  return { ...value, name: toolName, content: value.content.normalize("NFKC").trim() };
}

export function createTool(
  definition: ToolDefinition,
  handler: ToolHandler,
  timeoutMs = 10_000,
): Tool {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Timeout da Tool deve ser positivo");
  return {
    name: definition.name,
    matches(input) {
      const normalized = normalizeInput(input);
      return normalized.length > 0 && definition.patterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(normalized);
      });
    },
    async execute(input, partialContext = {}) {
      const normalized = normalizeInput(input);
      if (!normalized) throw new ToolExecutionError(definition.name, "Entrada da Tool está vazia");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      const externalSignal = partialContext.signal;
      const abortFromExternal = () => controller.abort(externalSignal?.reason);
      externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
      try {
        const result = await Promise.race([
          handler(normalized, {
            tenantId: partialContext.tenantId,
            conversationExternalId: partialContext.conversationExternalId,
            state: partialContext.state,
            signal: controller.signal,
          }),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => reject(new ToolExecutionError(definition.name, `Tool excedeu o timeout de ${timeoutMs} ms`)),
              { once: true },
            );
          }),
        ]);
        return validateResult(definition.name, result);
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        throw new ToolExecutionError(definition.name, "Falha ao executar a Tool", { cause: error });
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abortFromExternal);
      }
    },
  };
}

/** Runtime registry. It is intentionally empty until a real adapter is registered. */
export const tools: Tool[] = [];

export function registerTool(tool: Tool) {
  if (!tool.name.trim()) throw new Error("Tool sem nome não pode ser registrada");
  const existing = tools.findIndex((candidate) => candidate.name === tool.name);
  if (existing >= 0) tools.splice(existing, 1, tool);
  else tools.push(tool);
  return tool;
}

export function registerToolHandler(name: string, handler: ToolHandler, timeoutMs?: number) {
  const definition = toolDefinitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Tool desconhecida: ${name}`);
  return registerTool(createTool(definition, handler, timeoutMs));
}

function endpoint(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Endpoint da Tool deve usar HTTP ou HTTPS");
  return parsed.toString();
}

export function toolAuthHeaders(auth: ToolAuth | undefined): Record<string, string> {
  if (!auth || auth.type === "none") return {};
  if (auth.type === "bearer") return { authorization: `Bearer ${auth.token}` };
  if (auth.type === "basic") return { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` };
  return { [auth.headerName]: auth.value };
}

/** Creates a real HTTP adapter using the stable Tool request/result contract. */
export function createHttpToolAdapter(config: HttpToolConfig): Tool {
  const definition = toolDefinitions.find((candidate) => candidate.name === config.name);
  if (!definition) throw new Error(`Tool desconhecida: ${config.name}`);
  const url = endpoint(config.endpoint);
  return createTool(definition, async (input, context) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...toolAuthHeaders(config.auth) },
      body: JSON.stringify({
        tool: config.name,
        input,
        tenantId: context.tenantId,
        conversationExternalId: context.conversationExternalId,
        state: context.state,
      }),
      signal: context.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Tool HTTP ${response.status}: ${raw.slice(0, 300)}`);
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch (error) { throw new Error("Tool retornou JSON inválido", { cause: error }); }
    return value as ToolResult;
  }, config.timeoutMs);
}

export async function testHttpTool(config: HttpToolConfig) {
  const url = endpoint(config.endpoint);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: toolAuthHeaders(config.auth),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    // A POST-only Tool commonly answers 405 to the side-effect-free probe. That
    // still proves that the endpoint and its authentication are reachable.
    return { healthy: response.ok || response.status === 405, status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { healthy: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : "connection_failed" };
  }
}

export async function runConfiguredTools(input: string, configuredTools: readonly Tool[], context: Omit<Partial<ToolContext>, "signal"> = {}) {
  const matching = configuredTools.filter((tool) => tool.matches(input));
  return Promise.all(matching.map((tool) => tool.execute(input, context)));
}

export function unregisterTool(name: string) {
  const index = tools.findIndex((candidate) => candidate.name === name);
  if (index >= 0) tools.splice(index, 1);
}

export function clearTools() {
  tools.splice(0, tools.length);
}

/**
 * Runs only explicitly registered adapters. An absent adapter yields no result,
 * allowing the existing Tool → RAG policy to continue without fabricated data.
 */
export async function runMatchingTools(input: string, context: Omit<Partial<ToolContext>, "signal"> = {}) {
  const matching = tools.filter((tool) => tool.matches(input));
  return Promise.all(matching.map((tool) => tool.execute(input, context)));
}

function registerExplicitDevelopmentStubs() {
  if (process.env.ENABLE_MOCK_TOOLS !== "true") return;
  for (const definition of toolDefinitions) {
    registerToolHandler(definition.name, async () => ({
      name: definition.name,
      found: false,
      content: `${definition.description} Adaptador de desenvolvimento sem fonte externa.`,
      data: { mocked: true, explicitlyEnabled: true },
    }));
  }
}

registerExplicitDevelopmentStubs();
