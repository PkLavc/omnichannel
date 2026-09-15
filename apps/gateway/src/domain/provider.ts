export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type CompletionRequest = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type CompletionResult = {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
};

export type RoutedCompletionResult = CompletionResult & {
  provider: string;
  fallback: boolean;
  attemptedProviders: string[];
  failures: Array<{ provider: string; error: string }>;
};

export interface AiProvider {
  readonly name: string;
  health(): Promise<boolean>;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export function withCompletionDefaults(
  provider: AiProvider,
  defaults: Required<Pick<CompletionRequest, "temperature" | "maxTokens">>,
): AiProvider {
  return {
    name: provider.name,
    health: () => provider.health(),
    complete: request => provider.complete({ ...request, ...defaults }),
  };
}

export class ProviderRouter {
  constructor(
    private readonly providers: readonly AiProvider[],
    private readonly maxPasses = 1,
  ) {}

  async complete(request: CompletionRequest): Promise<RoutedCompletionResult> {
    if (this.providers.length === 0) {
      throw new Error("Nenhum provedor foi configurado.");
    }

    const attemptedProviders: string[] = [];
    const failures: Array<{ provider: string; error: string }> = [];

    for (let pass = 1; pass <= Math.max(1, Math.min(3, this.maxPasses)); pass++) {
      for (const provider of this.providers) {
      attemptedProviders.push(provider.name);

      try {
        const healthy = await provider.health();
        if (!healthy) {
          failures.push({ provider: provider.name, error: "health check falhou" });
          continue;
        }

        const result = await provider.complete(request);
        if (!result.text.trim()) {
          throw new Error("resposta vazia");
        }

        return {
          ...result,
          provider: provider.name,
          fallback: attemptedProviders.length > 1,
          attemptedProviders: [...attemptedProviders],
          failures: [...failures],
        };
      } catch (error) {
        failures.push({ provider: provider.name, error: errorMessage(error) });
      }
      }
      if (pass < this.maxPasses) await new Promise(resolve => setTimeout(resolve, 350));
    }

    throw new Error(`Nenhum provedor disponível. ${failures.map(failure => `${failure.provider}: ${failure.error}`).join("; ")}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "erro desconhecido";
}
