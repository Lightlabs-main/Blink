#!/usr/bin/env bash
# Switch the Blink API between devnet and mainnet (docs/MAINNET_GO_LIVE.md). Run from the repository root on the server.
#
#   bash scripts/switch-network.sh mainnet     # .env.mainnet becomes .env
#   bash scripts/switch-network.sh devnet      # .env.devnet becomes .env
#
# Every step is checked: the target file is validated with the API's own config rules, the database and the current
# .env are backed up, the API restarts and must answer /health on the expected cluster within 30 s — otherwise the
# previous .env is restored and the API restarted on it. Moves no funds and sends no transactions.
set -euo pipefail
# Backups hold secrets (.env) and user data (database dumps): owner-only.
umask 077

TARGET="${1:-}"
case "$TARGET" in
  mainnet) EXPECT="mainnet-beta" ;;
  devnet) EXPECT="devnet" ;;
  *) echo "usage: bash scripts/switch-network.sh mainnet|devnet" >&2; exit 2 ;;
esac
SRC=".env.$TARGET"
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }
[ -f .env ] || { echo "missing .env" >&2; exit 1; }

echo "1/5 validating $SRC"
npx tsx scripts/check-env.ts "$SRC"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
echo "2/5 backing up .env and the database"
cp .env "backups/env-$TS-before-$TARGET"
DB_USER="$(grep -E '^DATABASE_URL=' .env | sed -E 's#^DATABASE_URL=postgres(ql)?://([^:]+):.*#\2#')"
DB_NAME="$(grep -E '^BLINK_DATABASE_NAME=' .env | cut -d= -f2-)"
docker exec blink-postgres pg_dump -U "$DB_USER" -d "${DB_NAME:-blink_to_stock}" -Fc > "backups/${DB_NAME:-blink_to_stock}-$TS-before-$TARGET.dump"

echo "3/5 switching .env to $TARGET"
cp "$SRC" .env

echo "4/5 restarting blink-api"
pm2 restart blink-api --update-env >/dev/null

PORT="$(grep -E '^API_PORT=' .env | cut -d= -f2-)"
echo "5/5 waiting for /health on $EXPECT"
for _ in $(seq 1 15); do
  sleep 2
  if curl -fsS "http://127.0.0.1:${PORT:-4310}/health" 2>/dev/null | grep -q "\"cluster\":\"$EXPECT\""; then
    echo "OK: blink-api is on $EXPECT"
    curl -fsS "http://127.0.0.1:${PORT:-4310}/v1/status" && echo
    exit 0
  fi
done

echo "FAILED: /health did not report $EXPECT — restoring the previous .env" >&2
cp "backups/env-$TS-before-$TARGET" .env
pm2 restart blink-api --update-env >/dev/null
exit 1
