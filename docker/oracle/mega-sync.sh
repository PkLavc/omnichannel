#!/bin/sh
set -eu

MODE="${1:-check}"
DATA_ROOT="${OMNICHANNEL_DATA_ROOT:-/opt/omnichannel-data}"
MEGA_ENV="$DATA_ROOT/config/mega.env"
LOCK_FILE="$DATA_ROOT/_local/mega-sync.lock"

if [ ! -r "$MEGA_ENV" ]; then
  echo "Credencial privada ausente: $MEGA_ENV" >&2
  exit 1
fi

mkdir -p "$DATA_ROOT/_local"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo 'Outra sincronização MEGA já está em andamento.' >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$MEGA_ENV"
set +a

: "${RCLONE_CONFIG_MEGA_USER:?Usuário MEGA ausente}"
: "${RCLONE_CONFIG_MEGA_PASS:?Senha MEGA ausente}"
MEGA_REMOTE_PATH="${MEGA_REMOTE_PATH:-omnichannel-private/private-data}"
REMOTE="mega:$MEGA_REMOTE_PATH"

set -- --config /dev/null --checkers 4 --transfers 2 --retries 5 --low-level-retries 10 \
  --exclude '/_local/**' \
  --exclude '/backups/**' \
  --exclude '/imports/hablla/raw/**' \
  --exclude '/archives/*.tmp.tar.gz' \
  --exclude '/archives/*.tar.gz.tmp' \
  --exclude '/config/mega.env' \
  --exclude '/config/platform.env' \
  --exclude '/config/publication.env'

marker="$(rclone lsf "$REMOTE/.omnichannel-data-root" --config /dev/null --checkers 2 --retries 3 --files-only)"
if [ "$marker" != '.omnichannel-data-root' ]; then
  echo 'A raiz remota não possui o marcador de segurança esperado.' >&2
  exit 1
fi

case "$MODE" in
  check)
    rclone size "$REMOTE" "$@" --json | jq '{count, bytes, gib: (.bytes / 1073741824)}'
    ;;
  pull)
    remote_count="$(rclone size "$REMOTE" "$@" --json | jq -r '.count')"
    if [ "$remote_count" -le 1 ]; then
      echo 'A cópia remota ainda não contém dados para restauração.' >&2
      exit 1
    fi
    echo 'Baixando alterações privadas do MEGA para a Oracle...'
    rclone copy "$REMOTE" "$DATA_ROOT" "$@" --update
    echo 'Download privado concluído.'
    ;;
  push)
    if [ ! -f "$DATA_ROOT/.omnichannel-data-root" ]; then
      echo 'O marcador local de segurança está ausente; envio cancelado.' >&2
      exit 1
    fi
    echo 'Enviando o estado privado da Oracle para o MEGA...'
    rclone copy "$DATA_ROOT" "$REMOTE" "$@" --update
    echo 'Backup remoto concluído.'
    ;;
  *)
    echo "Uso: $0 [check|pull|push]" >&2
    exit 2
    ;;
esac
