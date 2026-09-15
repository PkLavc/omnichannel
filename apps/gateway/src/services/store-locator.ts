import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ToolResult } from "../domain/types.js";

export type StoreLocation = {
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
};

type GeocodedLocation = {
  latitude: number;
  longitude: number;
  displayName: string;
  kind: string;
  city?: string;
  state?: string;
};

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

function validStores(value: unknown): StoreLocation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    if (![row.name, row.address, row.city, row.state].every(part => typeof part === "string" && part.trim())
        || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
      name: String(row.name).trim(), address: String(row.address).trim(), city: String(row.city).trim(),
      state: String(row.state).trim(), latitude, longitude,
    }];
  });
}

export function parseStoreLocations(value: unknown) {
  return validStores(value);
}

function distanceKm(first: { latitude: number; longitude: number }, second: { latitude: number; longitude: number }) {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = rad(second.latitude - first.latitude);
  const dLon = rad(second.longitude - first.longitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(first.latitude)) * Math.cos(rad(second.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function locationKey(query: string) {
  return `nominatim:${createHash("sha256").update(normalized(query)).digest("hex")}`;
}

async function geocode(
  prisma: PrismaClient,
  query: string,
  fetchImpl: typeof fetch,
): Promise<GeocodedLocation | undefined> {
  const key = locationKey(query);
  const cached = await prisma.locationCache.findUnique({ where: { key } });
  if (cached && cached.expiresAt > new Date()) {
    return {
      latitude: cached.latitude,
      longitude: cached.longitude,
      displayName: cached.displayName || query,
      kind: "cached",
    };
  }

  let search = query.trim();
  const cep = search.replace(/\D/g, "");
  if (/^\d{8}$/.test(cep)) {
    const response = await fetchImpl(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(5_000) });
    const data = response.ok ? await response.json() as Record<string, unknown> : {};
    if (data.erro === true) return undefined;
    search = [data.logradouro, data.bairro, data.localidade, data.uf, cep, "Brasil"].filter(Boolean).join(", ");
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "br");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", search);
  const response = await fetchImpl(url, {
    headers: { "user-agent": "NexusOmnichannel/1.0 (admin@pklavc.com)", accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Geocodificação HTTP ${response.status}`);
  const rows = await response.json() as Array<Record<string, unknown>>;
  const row = rows[0];
  const latitude = Number(row?.lat);
  const longitude = Number(row?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const address = row.address && typeof row.address === "object" ? row.address as Record<string, unknown> : {};
  const result: GeocodedLocation = {
    latitude,
    longitude,
    displayName: typeof row.display_name === "string" ? row.display_name : query,
    kind: typeof row.addresstype === "string" ? row.addresstype : "",
    city: String(address.city || address.town || address.municipality || "").trim() || undefined,
    state: String(address.state || "").trim() || undefined,
  };
  await prisma.locationCache.upsert({
    where: { key },
    create: { key, query, latitude, longitude, displayName: result.displayName, expiresAt: new Date(Date.now() + 30 * 86400_000) },
    update: { query, latitude, longitude, displayName: result.displayName, expiresAt: new Date(Date.now() + 30 * 86400_000) },
  });
  return result;
}

export async function locateNearestStore(options: {
  prisma: PrismaClient;
  query: string;
  stores: readonly StoreLocation[];
  fetchImpl?: typeof fetch;
  maximumDistanceKm?: number;
}): Promise<ToolResult> {
  const query = options.query.normalize("NFKC").trim();
  if (!query || !options.stores.length) {
    return { name: "consultarUnidade", found: false, content: "Não há localização ou unidades oficiais configuradas para calcular a proximidade." };
  }
  const exactCityMatches = options.stores.filter(store => normalized(store.city) === normalized(query));
  if (exactCityMatches.length > 1) {
    return {
      name: "consultarUnidade",
      found: true,
      content: `Temos unidades em ${query}: ${exactCityMatches.map(store => store.name).join(", ")}. Informe o bairro, CEP ou endereço para eu calcular qual é a mais próxima.`,
      data: { needsMorePrecision: true },
    };
  }
  const place = await geocode(options.prisma, query, options.fetchImpl ?? fetch);
  if (!place) return { name: "consultarUnidade", found: false, content: `Não consegui localizar ${query}. Informe um bairro, cidade, CEP ou endereço.` };

  const cityMatches = options.stores.filter(store => normalized(store.city) === normalized(query) || (place.city && normalized(store.city) === normalized(place.city)));
  if (["city", "town", "municipality", "state"].includes(place.kind) && cityMatches.length > 1) {
    return {
      name: "consultarUnidade",
      found: true,
      content: `Temos unidades em ${query}: ${cityMatches.map(store => store.name).join(", ")}. Informe o bairro, CEP ou endereço para eu calcular qual é a mais próxima.`,
      data: { needsMorePrecision: true },
    };
  }

  const ranked = options.stores
    .map(store => ({ store, distance: distanceKm(place, store) }))
    .sort((left, right) => left.distance - right.distance);
  const closest = ranked[0];
  const maximum = options.maximumDistanceKm ?? 150;
  if (!closest || closest.distance > maximum) {
    return {
      name: "consultarUnidade",
      found: false,
      content: `Não temos unidade próxima a ${query}. Posso ajudar com outro produto ou serviço da empresa.`,
      data: { nearestDistanceKm: closest ? Number(closest.distance.toFixed(1)) : undefined },
    };
  }
  return {
    name: "consultarUnidade",
    found: true,
    content: `A unidade mais próxima de ${query} é ${closest.store.name}, aproximadamente ${closest.distance.toFixed(1)} km: ${closest.store.address}`,
    data: {
      selectedUnit: closest.store.name,
      address: closest.store.address,
      distanceKm: Number(closest.distance.toFixed(1)),
    },
  };
}
