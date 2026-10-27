#!/bin/sh
# Encrypted logical backups of the Kovan database.
#   backup.sh once          one backup now
#   backup.sh loop          one backup every day at BACKUP_HOUR_UTC
#   backup.sh restore FILE  restore FILE into DATABASE_URL (asks nothing; the target is replaced)
# Needs DATABASE_URL and BACKUP_PASSPHRASE. Files land in /backups (BACKUP_DIR) as
# kovan-YYYYmmdd-HHMMSS.dump.enc and are deleted after BACKUP_KEEP_DAYS days. Copy that folder
# off the machine (object storage with versioning), and keep the passphrase somewhere else:
# without it, and without ENCRYPTION_KEYS, a backup can't be read.
set -eu
# A failed dump must not leave a file that looks like a backup.
set -o pipefail

DIR="${BACKUP_DIR_IN_CONTAINER:-/backups}"
KEEP="${BACKUP_KEEP_DAYS:-14}"

need() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    echo "backup: $1 is not set" >&2
    exit 1
  fi
}

once() {
  need DATABASE_URL
  need BACKUP_PASSPHRASE
  mkdir -p "$DIR"
  name="kovan-$(date -u +%Y%m%d-%H%M%S).dump.enc"
  tmp="$DIR/.$name.partial"
  trap 'rm -f "$tmp"' EXIT
  # Custom format (compressed, restorable table by table), encrypted before it touches disk.
  pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" |
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$tmp"
  mv "$tmp" "$DIR/$name"
  trap - EXIT
  find "$DIR" -name 'kovan-*.dump.enc' -mtime "+$KEEP" -delete
  echo "backup: wrote $name ($(wc -c <"$DIR/$name") bytes)"
}

restore() {
  need DATABASE_URL
  need BACKUP_PASSPHRASE
  [ -f "$1" ] || { echo "backup: no such file: $1" >&2; exit 1; }
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$1" |
    pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL"
  echo "backup: restored $1"
}

case "${1:-once}" in
  once) once ;;
  restore) restore "${2:?usage: backup.sh restore FILE}" ;;
  loop)
    hour="${BACKUP_HOUR_UTC:-2}"
    last=""
    while :; do
      today="$(date -u +%Y%m%d)"
      if [ "$(date -u +%H | sed 's/^0//')" = "$hour" ] && [ "$today" != "$last" ]; then
        once && last="$today" || echo "backup: FAILED" >&2
      fi
      sleep 300
    done
    ;;
  *) echo "usage: backup.sh once | loop | restore FILE" >&2; exit 1 ;;
esac
