#!/bin/sh
# Weekly restore drill on the production host: the newest backup goes into a throwaway Postgres
# (no network, data in memory), and the result lands in /srv/kovan/ops/restore.json, which
# ops-status.py puts in the host's report, so the outside monitor says when a drill fails or
# none ran for over 8 days. The backup is decrypted inside the backup container (the passphrase
# never leaves it) and streamed straight into the throwaway database; nothing plain touches disk.
# Runs from cron as root (deploy/README.md, "Outside monitor"):
#   0 4 * * 0 root /srv/kovan/src/deploy/restore-drill.sh
set -u
OPS=${KOVAN_OPS_DIR:-/srv/kovan/ops}
BACKUPS=${KOVAN_BACKUP_DIR:-/srv/kovan/backups}
DRILL=kovan-restore-drill
LIVE=kovan-prod-postgres-1
BACKUP=kovan-prod-backup-1
mkdir -p "$OPS"

result() {
  # ok, detail, then the counts as JSON (empty when unknown).
  python3 - "$1" "$2" "${name:-}" "${sha:-}" "${counts:-{\}}" >"$OPS/.restore.json" <<'PY'
import json, sys
from datetime import datetime, timezone
ok, detail, file, sha, counts = sys.argv[1:6]
json.dump({
    "at": datetime.now(timezone.utc).isoformat(),
    "ok": ok == "true",
    "detail": detail,
    "file": file or None,
    "sha256": sha or None,
    "counts": json.loads(counts),
}, sys.stdout)
PY
  chmod 644 "$OPS/.restore.json"
  mv "$OPS/.restore.json" "$OPS/restore.json"
  echo "restore drill: $2"
}
cleanup() { docker rm -f "$DRILL" >/dev/null 2>&1; }
trap cleanup EXIT

file=$(ls -t "$BACKUPS"/kovan-*.dump.enc 2>/dev/null | head -1)
[ -n "$file" ] || { result false "There is no backup to restore."; exit 1; }
sha=$(sha256sum "$file" | cut -d' ' -f1)
name=$(basename "$file")

cleanup
docker run -d --name "$DRILL" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=kovan -e POSTGRES_DB=kovan \
  postgres:17-alpine >/dev/null || { result false "Couldn't start the throwaway Postgres."; exit 1; }
for _ in $(seq 1 60); do
  docker exec "$DRILL" pg_isready -U kovan -d kovan -q 2>/dev/null && break
  sleep 1
done

# shellcheck disable=SC2016 # expanded inside the backup container
if ! docker exec "$BACKUP" sh -c 'openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "/backups/$1"' _ "$name" |
  docker exec -i "$DRILL" pg_restore --no-owner --no-privileges --exit-on-error -U kovan -d kovan 2>"$OPS/.restore.err"; then
  result false "$name didn't restore: $(tail -c 300 "$OPS/.restore.err" | tr '\n' ' ')"
  rm -f "$OPS/.restore.err"
  exit 1
fi
rm -f "$OPS/.restore.err"

query() {
  docker exec "$1" psql -U kovan -d kovan -Atc "$2" 2>/dev/null
}
COUNTS="select count(*) from information_schema.tables where table_schema = 'public';
select count(*) from drizzle.__drizzle_migrations;
select count(*) from users;
select count(*) from workspaces;
select count(*) from sessions;"
set -- $(query "$DRILL" "$COUNTS")
r_tables=${1:-0} r_migrations=${2:-0} r_users=${3:-0} r_workspaces=${4:-0} r_sessions=${5:-0}
set -- $(query "$LIVE" "$COUNTS")
l_tables=${1:-0} l_migrations=${2:-0} l_users=${3:-0}
counts="{\"tables\": $r_tables, \"migrations\": $r_migrations, \"users\": $r_users, \"workspaces\": $r_workspaces, \"sessions\": $r_sessions, \"liveTables\": $l_tables, \"liveMigrations\": $l_migrations, \"liveUsers\": $l_users}"

# The schema can only be a migration or two behind the live one (a deploy after the backup), and
# the people can't be more than now or none at all.
if [ "$r_tables" -lt 1 ] || [ "$r_users" -lt 1 ] || [ "$r_users" -gt "$l_users" ] ||
  [ "$r_migrations" -gt "$l_migrations" ] || [ $((l_migrations - r_migrations)) -gt 2 ]; then
  result false "$name restored but looks wrong: $r_tables tables, $r_migrations migrations, $r_users people (live: $l_tables, $l_migrations, $l_users)."
  exit 1
fi
result true "$name restored: $r_tables tables, $r_users people, $r_workspaces workspaces, $r_sessions sessions."
