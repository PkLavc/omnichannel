import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { ChatwootClient } from "./chatwoot.js";

let url = "";
let requests: { method?: string; path: string; token?: string; body: any }[] = [];
let responseStatuses: number[] = [];
let responseBodies: unknown[] = [];
const server = createServer((request, response) => {
  let raw = "";
  request.on("data", chunk => raw += chunk);
  request.on("end", () => {
    requests.push({ method: request.method, path: request.url || "", token: request.headers.api_access_token as string, body: raw ? JSON.parse(raw) : undefined });
    const status = responseStatuses.shift() ?? 200;
    const responseBody = responseBodies.shift() ?? (status >= 400 ? { error: "falha simulada" } : { id: 1 });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
});
before(async () => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("test server unavailable"); url = `http://127.0.0.1:${address.port}`; });
after(() => server.close());
test("envia resposta e atribui conversa usando o contrato do Chatwoot", async () => {
  requests = [];
  responseStatuses = [];
  responseBodies = [];
  const client = new ChatwootClient({ url, accountId: "7", apiToken: "secret", teamId: 3 });
  await client.sendMessage("42", "Olá");
  await client.transferToHuman("42");
  assert.equal(requests[0].path, "/api/v1/accounts/7/conversations/42/messages");
  assert.equal(requests[0].token, "secret");
  assert.deepEqual(requests[0].body, { content: "Olá", message_type: "outgoing", private: false, content_type: "text" });
  assert.equal(requests[1].path, "/api/v1/accounts/7/conversations/42/assignments");
  assert.deepEqual(requests[1].body, { team_id: 3 });
});

test("rota de setor substitui a atribuição padrão sem herdar assignee global", async () => {
  requests = [];
  responseStatuses = [];
  responseBodies = [];
  const client = new ChatwootClient({
    url,
    accountId: "7",
    apiToken: "secret",
    teamId: 3,
    assigneeId: 9,
  });

  await client.transferToHuman("42", { teamId: 12 });

  assert.equal(requests[0].path, "/api/v1/accounts/7/conversations/42/assignments");
  assert.deepEqual(requests[0].body, { team_id: 12 });
});

test("rota de setor pode definir equipe e responsável específicos", async () => {
  requests = [];
  responseStatuses = [];
  responseBodies = [];
  const client = new ChatwootClient({ url, accountId: "7", apiToken: "secret", teamId: 3 });

  await client.transferToHuman("42", { teamId: 15, assigneeId: 21 });

  assert.deepEqual(requests[0].body, { assignee_id: 21, team_id: 15 });
});

test("repete falhas transitórias e interrompe em erro não recuperável", async () => {
  requests = [];
  responseStatuses = [500, 429, 200];
  responseBodies = [];
  const retrying = new ChatwootClient({ url, accountId: "7", apiToken: "secret" }, 3);
  await retrying.sendMessage("42", "retry");
  assert.equal(requests.length, 3);

  requests = [];
  responseStatuses = [401, 200];
  responseBodies = [];
  await assert.rejects(retrying.sendMessage("42", "unauthorized"), /Chatwoot HTTP 401/);
  assert.equal(requests.length, 1);
});

test("testa conta ou inbox sem enviar mensagens", async () => {
  requests = [];
  responseStatuses = [];
  responseBodies = [];
  const client = new ChatwootClient({ url, accountId: "7", inboxId: "11", apiToken: "secret" });
  assert.deepEqual(await client.testConnection(), { accountId: "7", inboxId: "11", inboxIds: ["11"] });
  assert.equal(requests[0].path, "/api/v1/accounts/7/inboxes/11");
  assert.equal(requests[0].token, "secret");
});

test("valida todos os canais vinculados à mesma empresa", async () => {
  requests = [];
  responseStatuses = [];
  responseBodies = [];
  const client = new ChatwootClient({
    url,
    accountId: "7",
    inboxId: "11",
    inboxIds: ["11", "12", "13"],
    apiToken: "secret",
  });

  assert.deepEqual(await client.testConnection(), {
    accountId: "7",
    inboxId: "11",
    inboxIds: ["11", "12", "13"],
  });
  assert.deepEqual(requests.map(request => request.path), [
    "/api/v1/accounts/7/inboxes/11",
    "/api/v1/accounts/7/inboxes/12",
    "/api/v1/accounts/7/inboxes/13",
  ]);
});

test("atualiza um atributo de lista existente quando a taxonomia mudar", async () => {
  requests = [];
  responseStatuses = [];
  responseBodies = [[{
    id: 44,
    attribute_key: "atendimento_resultado",
    attribute_display_type: 0,
    attribute_values: [],
  }], { id: 44 }];
  const client = new ChatwootClient({ url, accountId: "7", apiToken: "secret" });

  const result = await client.ensureConversationCustomAttributes([{
    key: "atendimento_resultado",
    name: "Resultado",
    description: "Resultado do fechamento.",
    displayType: 6,
    values: ["Venda realizada", "Sem venda"],
  }]);

  assert.deepEqual(result, { created: [], existing: [], updated: ["atendimento_resultado"] });
  assert.equal(requests[1].method, "PATCH");
  assert.equal(requests[1].path, "/api/v1/accounts/7/custom_attribute_definitions/44");
  assert.deepEqual(requests[1].body.attribute_values, ["Venda realizada", "Sem venda"]);
});

test("cria o webhook quando a conta ainda não possui a integração", async () => {
  requests = [];
  responseStatuses = [];
  responseBodies = [[], { id: 15 }];
  const client = new ChatwootClient({ url, accountId: "7", apiToken: "secret" });

  const result = await client.ensureWebhook("http://gateway:3001/webhooks/chatwoot/");

  assert.equal(result.action, "created");
  assert.deepEqual(requests.map(request => [request.method, request.path]), [
    ["GET", "/api/v1/accounts/7/webhooks"],
    ["POST", "/api/v1/accounts/7/webhooks"],
  ]);
  assert.deepEqual(requests[1].body, {
    name: "AI Gateway",
    url: "http://gateway:3001/webhooks/chatwoot",
    subscriptions: ["message_created", "conversation_updated", "conversation_status_changed"],
  });
});

test("atualiza de forma idempotente webhook existente por nome ou URL", async () => {
  const client = new ChatwootClient({ url, accountId: "7", apiToken: "secret" });

  requests = [];
  responseStatuses = [];
  responseBodies = [[{ id: 21, name: "AI Gateway", url: "http://gateway:3001/webhooks/antigo" }], { id: 21 }];
  assert.equal((await client.ensureWebhook("http://gateway:3001/webhooks/chatwoot")).action, "updated");
  assert.deepEqual(requests.map(request => [request.method, request.path]), [
    ["GET", "/api/v1/accounts/7/webhooks"],
    ["PATCH", "/api/v1/accounts/7/webhooks/21"],
  ]);

  requests = [];
  responseStatuses = [];
  responseBodies = [{ payload: { webhooks: [{ id: "22", name: "Integração anterior", url: "http://gateway:3001/webhooks/chatwoot/" }] } }, { id: 22 }];
  assert.equal((await client.ensureWebhook("http://gateway:3001/webhooks/chatwoot")).action, "updated");
  assert.equal(requests[1].path, "/api/v1/accounts/7/webhooks/22");
  assert.deepEqual(requests[1].body, {
    name: "AI Gateway",
    url: "http://gateway:3001/webhooks/chatwoot",
    subscriptions: ["message_created", "conversation_updated", "conversation_status_changed"],
  });
});

test("usa nome de webhook por tenant sem colidir na mesma conta Chatwoot", async () => {
  requests = [];
  responseStatuses = [];
  responseBodies = [
    [{ id: 10, name: "AI Gateway · outra-empresa", url: "http://gateway:3001/webhooks/chatwoot/outra-empresa" }],
    { id: 30 },
  ];
  const client = new ChatwootClient({ url, accountId: "7", apiToken: "secret" });

  const result = await client.ensureWebhook(
    "http://gateway:3001/webhooks/chatwoot/company-alpha",
    "AI Gateway · company-alpha",
  );

  assert.equal(result.action, "created");
  assert.deepEqual(requests[1].body, {
    name: "AI Gateway · company-alpha",
    url: "http://gateway:3001/webhooks/chatwoot/company-alpha",
    subscriptions: ["message_created", "conversation_updated", "conversation_status_changed"],
  });
});

test("reconcilia o nome legado ao migrar o webhook para a rota estável do tenant", async () => {
  requests = [];
  responseStatuses = [];
  responseBodies = [
    [{ id: 31, name: "AI Gateway · company-alpha", url: "http://gateway:3001/webhooks/chatwoot/company-alpha" }],
    { id: 31 },
  ];
  const client = new ChatwootClient({ url, accountId: "7", apiToken: "secret" });

  const result = await client.ensureWebhook(
    "http://gateway:3001/webhooks/chatwoot/tenant-stable-id",
    "AI Gateway - tenant-stable-id",
    ["AI Gateway · company-alpha"],
  );

  assert.equal(result.action, "updated");
  assert.equal(requests[1].path, "/api/v1/accounts/7/webhooks/31");
  assert.deepEqual(requests[1].body, {
    name: "AI Gateway - tenant-stable-id",
    url: "http://gateway:3001/webhooks/chatwoot/tenant-stable-id",
    subscriptions: ["message_created", "conversation_updated", "conversation_status_changed"],
  });
});
