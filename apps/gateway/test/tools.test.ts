import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ToolExecutionError,
  clearTools,
  createHttpToolAdapter,
  registerToolHandler,
  runConfiguredTools,
  runMatchingTools,
  testHttpTool,
  tools,
} from "../dist/services/tools.js";

test.beforeEach(() => clearTools());
test.after(() => clearTools());

test("no mock Tool participates in production execution by default", async () => {
  assert.equal(tools.length, 0);
  assert.deepEqual(await runMatchingTools("Tem estoque deste modelo?"), []);
});

test("a registered real adapter is matched, executed and validated", async () => {
  registerToolHandler("consultarEstoque", async (input, context) => ({
    name: "ignored-by-contract",
    found: true,
    content: `Disponível para: ${input}`,
    data: { tenantId: context.tenantId },
  }));
  const result = await runMatchingTools("Tem estoque do iPhone?", { tenantId: "tenant-1" });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "consultarEstoque");
  assert.equal(result[0].found, true);
  assert.equal(result[0].data?.tenantId, "tenant-1");
});

test("invalid adapter output and timeout are explicit failures", async () => {
  registerToolHandler("consultarGarantia", async () => ({
    name: "consultarGarantia",
    found: false,
    content: "",
  }));
  await assert.rejects(
    runMatchingTools("Qual a garantia?"),
    (error: unknown) => error instanceof ToolExecutionError && /conteúdo vazio/.test(error.message),
  );

  registerToolHandler("agendamento", async () => new Promise(() => undefined), 10);
  await assert.rejects(
    runMatchingTools("Quero agendar"),
    (error: unknown) => error instanceof ToolExecutionError && /timeout/.test(error.message),
  );
});

test("appointment Tool recognizes availability in singular, plural and without accents", async () => {
  registerToolHandler("agendamento", async () => ({ found: true, content: "ok" }));

  assert.equal((await runMatchingTools("Qual horario disponivel?")).length, 1);
  assert.equal((await runMatchingTools("Quais horários disponíveis?")).length, 1);
  assert.equal((await runMatchingTools("Tem disponibilidade para atendimento?")).length, 1);
  assert.equal((await runMatchingTools("Qual unidade temhorario disponivel?")).length, 1);
});

test("configured HTTP Tool sends standardized payload and authentication", async () => {
  let received: { authorization?: string; body?: any } = {};
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.authorization = request.headers.authorization;
      if (request.method === "POST") received.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.method === "POST" ? { found: true, content: "available" } : { ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const config = { name: "consultarEstoque", endpoint: `http://127.0.0.1:${address.port}`, timeoutMs: 2_000, auth: { type: "bearer", token: "secret" } as const };
  try {
    const result = await runConfiguredTools("Tem estoque?", [createHttpToolAdapter(config)], {
      tenantId: "tenant-1",
      conversationExternalId: "conversation-1",
      state: { unidadeDesejada: "Moema" },
    });
    assert.equal(result[0].content, "available");
    assert.equal(received.authorization, "Bearer secret");
    assert.deepEqual(received.body, {
      tool: "consultarEstoque",
      input: "Tem estoque?",
      tenantId: "tenant-1",
      conversationExternalId: "conversation-1",
      state: { unidadeDesejada: "Moema" },
    });
    assert.equal((await testHttpTool(config)).healthy, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
