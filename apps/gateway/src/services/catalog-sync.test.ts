import assert from "node:assert/strict";
import test from "node:test";
import { catalogSyncDue, fetchCatalog } from "./catalog-sync.js";

test("catálogo respeita intervalo e fonte HTTPS", async () => {
  assert.equal(catalogSyncDue(null, 240), true);
  assert.equal(catalogSyncDue(new Date(Date.now() - 239 * 60_000), 240), false);
  const rows = await fetchCatalog({ url: "https://catalog.example/items", itemsPath: "data.items", timeoutMs: 1_000 }, async () => new Response(JSON.stringify({ data: { items: [{ name: "Modelo", price: 10 }] } })));
  assert.equal(rows.length, 1);
  await assert.rejects(() => fetchCatalog({ url: "http://catalog.example/items", itemsPath: "items", timeoutMs: 1_000 }));
});
