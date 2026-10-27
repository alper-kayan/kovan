#!/bin/sh
# On the production host, after the source was synced to /srv/kovan/src: builds the server image
# and restarts the server alone (Postgres, the backups and the demo machine keep running).
#   ssh root@<host> /srv/kovan/src/deploy/rebuild-server.sh
set -eu
cd /srv/kovan/src
compose() {
  docker compose -p kovan-prod -f deploy/docker-compose.single-host.yml \
    -f deploy/docker-compose.founderos.yml --env-file /srv/kovan/.env "$@"
}
compose build server
compose up -d --no-deps server
sleep 8
docker ps --format '{{.Names}} {{.Status}}' | grep kovan-prod-server
