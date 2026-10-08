#!/bin/sh
# api is the only service that changes the schema: migrate, seed the admin, then serve.
set -e

# Started as root only to hand the uploads volume to the unprivileged user (a volume
# created by an earlier release belongs to root); everything else runs as `node`.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${UPLOAD_DIR:-/data/uploads}"
  chown -R node:node "${UPLOAD_DIR:-/data/uploads}"
  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
fi

node_modules/.bin/prisma migrate deploy
node dist/seed/run.js
exec node dist/server.js
