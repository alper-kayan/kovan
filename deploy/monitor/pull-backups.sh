#!/bin/sh
# Copies the server's encrypted nightly backups to this machine (run daily by
# kovan-backups.timer). The server lets this key read its backups folder and nothing else
# (rrsync -ro in root's authorized_keys); the server can't reach here. Copies older than
# KEEP_DAYS go; the monitor says when the newest one here is more than 30 hours old.
set -eu
DEST="${KOVAN_BACKUPS_DIR:-$HOME/kovan-backups}"
HOST="${KOVAN_BACKUP_HOST:-root@31.57.156.109}"
KEEP_DAYS="${KOVAN_BACKUPS_KEEP_DAYS:-30}"
mkdir -p "$DEST"
chmod 700 "$DEST"
# Only finished files: the server writes .<name>.partial and renames it when done.
rsync -a --ignore-existing --include 'kovan-*.dump.enc' --exclude '*' \
  -e "ssh -i $HOME/.ssh/kovan-backups -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
  "$HOST:./" "$DEST/"
find "$DEST" -name 'kovan-*.dump.enc' -mtime +"$KEEP_DAYS" -delete
echo "$(ls "$DEST" | grep -c '^kovan-') backups here, newest $(ls -t "$DEST" | head -1)"
