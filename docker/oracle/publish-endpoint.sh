#!/bin/sh
set -eu

MODE="${1:-online}"
PROJECT_DIR="${OMNICHANNEL_PROJECT_DIR:-/opt/omnichannel}"
DATA_ROOT="${OMNICHANNEL_DATA_ROOT:-/opt/omnichannel-data}"
PLATFORM_ENV="$DATA_ROOT/config/platform.env"
PUBLICATION_ENV="$DATA_ROOT/config/publication.env"
COMPOSE="docker compose --project-directory $PROJECT_DIR --env-file $PLATFORM_ENV -f $PROJECT_DIR/docker-compose.yml -f $PROJECT_DIR/docker-compose.oracle.yml"

if [ ! -r "$PUBLICATION_ENV" ]; then
  echo "Arquivo privado ausente: $PUBLICATION_ENV" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$PUBLICATION_ENV"
set +a

: "${GITHUB_TOKEN:?GITHUB_TOKEN ausente em publication.env}"
: "${PUBLIC_STATUS_GIST_ID:?PUBLIC_STATUS_GIST_ID ausente em publication.env}"
PUBLIC_STATUS_GIST_FILENAME="${PUBLIC_STATUS_GIST_FILENAME:-nexus-omnichannel-endpoint.json}"
GIST_API="https://api.github.com/gists/$PUBLIC_STATUS_GIST_ID"

read_existing_manifest() {
  curl -fsS -H 'Accept: application/vnd.github+json' -H 'User-Agent: omnichannel-oracle-publisher' "$GIST_API" \
    | jq -r --arg filename "$PUBLIC_STATUS_GIST_FILENAME" '.files[$filename].content // "{}"'
}

publish_manifest() {
  manifest="$1"
  body="$(jq -n --arg filename "$PUBLIC_STATUS_GIST_FILENAME" --arg content "$manifest" \
    '{files: {($filename): {content: $content}}}')"
  curl -fsS -X PATCH \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H 'User-Agent: omnichannel-oracle-publisher' \
    -H 'Content-Type: application/json' \
    --data "$body" "$GIST_API" >/dev/null
}

now="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
existing="$(read_existing_manifest 2>/dev/null || printf '{}')"
if ! printf '%s' "$existing" | jq -e . >/dev/null 2>&1; then
  existing='{}'
fi

if [ "$MODE" = "offline" ]; then
  manifest="$(printf '%s' "$existing" | jq --arg updatedAt "$now" '.online = false | .updatedAt = $updatedAt')"
  publish_manifest "$manifest"
  echo "Manifesto público marcado como offline."
  exit 0
fi

if [ "$MODE" != "online" ]; then
  echo "Uso: $0 [online|offline]" >&2
  exit 2
fi

public_url=''
tunnel_attempt=1
while [ "$tunnel_attempt" -le 3 ] && [ -z "$public_url" ]; do
  attempt=0
  while [ "$attempt" -lt 75 ]; do
    candidate="$($COMPOSE logs --no-color public-tunnel 2>&1 \
      | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1 || true)"
    if [ -n "$candidate" ] && curl --doh-url https://cloudflare-dns.com/dns-query -fsS --max-time 10 "$candidate/health" >/dev/null 2>&1; then
      public_url="$candidate"
      break
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  if [ -z "$public_url" ] && [ "$tunnel_attempt" -lt 3 ]; then
    echo "O endereço do túnel $tunnel_attempt não ficou acessível; solicitando outro." >&2
    $COMPOSE up -d --no-deps --force-recreate public-tunnel >/dev/null
  fi
  tunnel_attempt=$((tunnel_attempt + 1))
done

if [ -z "$public_url" ]; then
  echo 'A Cloudflare não publicou um endpoint saudável após três tentativas.' >&2
  exit 1
fi

current_frontend="$(sed -n 's/^CHATWOOT_FRONTEND_URL=//p' "$PLATFORM_ENV" | tail -n 1)"
if [ "$current_frontend" != "$public_url" ]; then
  temporary="$(mktemp "$DATA_ROOT/config/platform.env.XXXXXX")"
  awk -v url="$public_url" '
    BEGIN { replaced = 0 }
    /^CHATWOOT_FRONTEND_URL=/ { print "CHATWOOT_FRONTEND_URL=" url; replaced = 1; next }
    { print }
    END { if (!replaced) print "CHATWOOT_FRONTEND_URL=" url }
  ' "$PLATFORM_ENV" >"$temporary"
  chown --reference="$PLATFORM_ENV" "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$PLATFORM_ENV"
  $COMPOSE up -d --no-deps --force-recreate chatwoot chatwoot-worker >/dev/null
fi

attempt=0
while [ "$attempt" -lt 60 ]; do
  if curl --doh-url https://cloudflare-dns.com/dns-query -fsS --max-time 10 "$public_url/health" >/dev/null 2>&1 \
    && curl --doh-url https://cloudflare-dns.com/dns-query -fsS --max-time 10 "$public_url/app/login" >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$attempt" -ge 60 ]; then
  echo 'Chatwoot ou Gateway não respondeu após atualizar a URL pública.' >&2
  exit 1
fi

manifest="$(printf '%s' "$existing" | jq \
  --arg publicUrl "$public_url" --arg updatedAt "$now" \
  '.online = true | .chatwootBaseUrl = $publicUrl | .gatewayBaseUrl = $publicUrl | .updatedAt = $updatedAt')"
publish_manifest "$manifest"

confirmed="$(read_existing_manifest)"
printf '%s' "$confirmed" | jq -e --arg publicUrl "$public_url" \
  '.online == true and .chatwootBaseUrl == $publicUrl and .gatewayBaseUrl == $publicUrl' >/dev/null
printf 'Endpoint público confirmado: %s\n' "$public_url"
