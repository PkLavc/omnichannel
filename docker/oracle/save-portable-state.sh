#!/bin/sh
set -eu

DATA_ROOT="${OMNICHANNEL_DATA_ROOT:-/opt/omnichannel-data}"
PLATFORM_ENV="$DATA_ROOT/config/platform.env"
STATE_ROOT="$DATA_ROOT/state"
PROJECT_NAME="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$PLATFORM_ENV" | tail -n 1)"
PROJECT_NAME="${PROJECT_NAME:-omnichannel-platform}"
POSTGRES_CONTAINER="${PROJECT_NAME}-postgres-1"
REDIS_CONTAINER="${PROJECT_NAME}-redis-1"
STATE_ID="$(cat /proc/sys/kernel/random/uuid | tr -d '-')"
BUILDING="$STATE_ROOT/.building-$STATE_ID"
CURRENT="$STATE_ROOT/current"
PREVIOUS="$STATE_ROOT/.previous"
ARCHIVE_IMAGE='pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb'

case "$STATE_ROOT" in
  "$DATA_ROOT"/state) ;;
  *) echo 'Raiz de estado inválida.' >&2; exit 1 ;;
esac

cleanup() {
  case "$BUILDING" in
    "$STATE_ROOT"/.building-*) rm -rf -- "$BUILDING" ;;
  esac
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$BUILDING"

if [ "$(docker inspect -f '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)" != 'true' ]; then
  echo 'PostgreSQL não está em execução; backup cancelado.' >&2
  exit 1
fi

for database in gateway chatwoot n8n; do
  docker exec "$POSTGRES_CONTAINER" pg_dump -U platform -Fc -d "$database" >"$BUILDING/postgres-$database.dump"
done

if [ "$(docker inspect -f '{{.State.Running}}' "$REDIS_CONTAINER" 2>/dev/null || true)" = 'true' ]; then
  docker exec "$REDIS_CONTAINER" redis-cli SAVE >/dev/null
fi

volumes=''
for volume in chatwoot_storage n8n_data redis_data; do
  full_volume="${PROJECT_NAME}_$volume"
  if docker volume inspect "$full_volume" >/dev/null 2>&1; then
    docker run --rm -v "$full_volume:/source:ro" -v "$BUILDING:/backup" "$ARCHIVE_IMAGE" \
      tar -czf "/backup/$volume.tar.gz" -C /source .
    volumes="$volumes $volume"
  fi
done

cp "$PLATFORM_ENV" "$BUILDING/platform.env"
chmod 600 "$BUILDING/platform.env"

manifest="$(jq -n \
  --arg stateId "$STATE_ID" \
  --arg createdAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg composeProject "$PROJECT_NAME" \
  --arg volumes "${volumes# }" \
  '{schemaVersion: 1, stateId: $stateId, createdAt: $createdAt, composeProject: $composeProject,
    databases: ["gateway", "chatwoot", "n8n"], volumes: ($volumes | split(" ") | map(select(length > 0))),
    includes: ["clientes", "cartoes", "conversas", "contexto", "RAG", "Chatwoot", "n8n", "anexos", "configuracoes"], checksums: {}}')"
for file in "$BUILDING"/*; do
  name="$(basename "$file")"
  checksum="$(sha256sum "$file" | awk '{print $1}')"
  manifest="$(printf '%s' "$manifest" | jq --arg name "$name" --arg checksum "$checksum" '.checksums[$name] = $checksum')"
done
printf '%s\n' "$manifest" >"$BUILDING/manifest.json"

if [ -e "$PREVIOUS" ]; then
  rm -rf -- "$PREVIOUS"
fi
if [ -e "$CURRENT" ]; then
  mv "$CURRENT" "$PREVIOUS"
fi
mv "$BUILDING" "$CURRENT"
if [ -e "$PREVIOUS" ]; then
  rm -rf -- "$PREVIOUS"
fi
trap - EXIT HUP INT TERM
printf 'Estado portátil criado: %s\n' "$CURRENT"
