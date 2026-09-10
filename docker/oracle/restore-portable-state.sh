#!/bin/sh
set -eu

PROJECT_DIR="${OMNICHANNEL_PROJECT_DIR:-/opt/omnichannel}"
DATA_ROOT="${OMNICHANNEL_DATA_ROOT:-/opt/omnichannel-data}"
PLATFORM_ENV="$DATA_ROOT/config/platform.env"
CURRENT="$DATA_ROOT/state/current"
MANIFEST="$CURRENT/manifest.json"
COMPOSE="docker compose --project-directory $PROJECT_DIR --env-file $PLATFORM_ENV -f $PROJECT_DIR/docker-compose.yml -f $PROJECT_DIR/docker-compose.oracle.yml"
ARCHIVE_IMAGE='pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb'

if [ ! -r "$MANIFEST" ] || [ "$(jq -r '.schemaVersion // 0' "$MANIFEST")" != '1' ]; then
  echo 'Snapshot portátil ausente ou inválido.' >&2
  exit 1
fi

jq -r '.checksums | to_entries[] | [.key, .value] | @tsv' "$MANIFEST" | while IFS="$(printf '\t')" read -r name expected; do
  case "$name" in
    */*|'') echo "Nome de arquivo inválido no manifesto: $name" >&2; exit 1 ;;
  esac
  file="$CURRENT/$name"
  if [ ! -f "$file" ] || [ "$(sha256sum "$file" | awk '{print $1}')" != "$expected" ]; then
    echo "Checksum inválido: $name" >&2
    exit 1
  fi
done

for key in GATEWAY_ENCRYPTION_KEY N8N_ENCRYPTION_KEY CHATWOOT_SECRET_KEY_BASE ADMIN_TOKEN COMMERCIAL_EVENTS_TOKEN; do
  value="$(sed -n "s/^$key=//p" "$CURRENT/platform.env" | tail -n 1)"
  [ -n "$value" ] || continue
  temporary="$(mktemp "$DATA_ROOT/config/platform.env.XXXXXX")"
  awk -v target="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, target "=") == 1 { print target "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print target "=" value }
  ' "$PLATFORM_ENV" >"$temporary"
  chown --reference="$PLATFORM_ENV" "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$PLATFORM_ENV"
done

$COMPOSE stop --timeout 60 public-tunnel public-router admin gateway n8n chatwoot-worker chatwoot redis >/dev/null
$COMPOSE up -d postgres >/dev/null

attempt=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$PLATFORM_ENV")-postgres-1" 2>/dev/null || true)" = 'healthy' ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then echo 'PostgreSQL não ficou pronto.' >&2; exit 1; fi
  sleep 3
done

PROJECT_NAME="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$PLATFORM_ENV" | tail -n 1)"
POSTGRES_CONTAINER="${PROJECT_NAME}-postgres-1"
for database in gateway chatwoot n8n; do
  docker exec "$POSTGRES_CONTAINER" dropdb -U platform --if-exists --force "$database"
  docker exec "$POSTGRES_CONTAINER" createdb -U platform "$database"
  docker exec -i "$POSTGRES_CONTAINER" pg_restore -U platform --no-owner --no-privileges -d "$database" <"$CURRENT/postgres-$database.dump"
done

for volume in $(jq -r '.volumes[]' "$MANIFEST"); do
  case "$volume" in
    chatwoot_storage|n8n_data|redis_data) ;;
    *) echo "Volume não autorizado no snapshot: $volume" >&2; exit 1 ;;
  esac
  full_volume="${PROJECT_NAME}_$volume"
  docker volume create "$full_volume" >/dev/null
  docker run --rm -v "$full_volume:/target" -v "$CURRENT:/backup:ro" "$ARCHIVE_IMAGE" \
    sh -c "find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -xzf /backup/$volume.tar.gz -C /target"
done

mkdir -p "$DATA_ROOT/_local"
jq -r '.stateId' "$MANIFEST" >"$DATA_ROOT/_local/applied-state-id"
echo "Snapshot restaurado: $(jq -r '.createdAt' "$MANIFEST")"
