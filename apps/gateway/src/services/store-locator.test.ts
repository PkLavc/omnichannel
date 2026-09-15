import assert from "node:assert/strict";
import test from "node:test";
import { locateNearestStore, parseStoreLocations } from "./store-locator.js";

const stores = parseStoreLocations([
  { name: "Ipanema", address: "Rua Oficial, 540", city: "Rio de Janeiro", state: "RJ", latitude: -22.9846, longitude: -43.1973 },
  { name: "Tijuca", address: "Rua Oficial, 215", city: "Rio de Janeiro", state: "RJ", latitude: -22.9220, longitude: -43.2347 },
]);

function prismaCache() {
  const values = new Map<string, Record<string, unknown>>();
  return {
    locationCache: {
      findUnique: async ({ where }: { where: { key: string } }) => values.get(where.key) ?? null,
      upsert: async ({ where, create, update }: { where: { key: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const value = values.has(where.key) ? { ...values.get(where.key), ...update } : create;
        values.set(where.key, value);
        return value;
      },
    },
  };
}

test("cidade com várias unidades pede localização mais precisa", async () => {
  const result = await locateNearestStore({ prisma: prismaCache() as never, query: "Rio de Janeiro", stores });
  assert.equal(result.found, true);
  assert.equal(result.data?.needsMorePrecision, true);
  assert.match(result.content, /Ipanema/);
  assert.match(result.content, /bairro, CEP ou endereço/);
});

test("bairro calcula e devolve diretamente unidade e endereço oficiais", async () => {
  const fetchImpl = async () => new Response(JSON.stringify([{
    lat: "-22.9719740", lon: "-43.1842997", addresstype: "suburb",
    display_name: "Copacabana, Rio de Janeiro", address: { city: "Rio de Janeiro", state: "Rio de Janeiro" },
  }]), { status: 200, headers: { "content-type": "application/json" } });
  const result = await locateNearestStore({ prisma: prismaCache() as never, query: "Copacabana, Rio de Janeiro", stores, fetchImpl: fetchImpl as typeof fetch });
  assert.equal(result.found, true);
  assert.equal(result.data?.selectedUnit, "Ipanema");
  assert.match(result.content, /Rua Oficial, 540/);
  assert.doesNotMatch(result.content, /vou verificar/i);
});
