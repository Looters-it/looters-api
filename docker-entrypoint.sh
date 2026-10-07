#!/bin/sh
# api is the only service that changes the schema: migrate, seed the admin, then serve.
set -e
node_modules/.bin/prisma migrate deploy
node dist/seed/run.js
exec node dist/server.js
