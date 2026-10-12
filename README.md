# looters-api

The service that answers the browser: Node.js and TypeScript with Fastify and Prisma. It owns the database schema (PostgreSQL with PostGIS), validates every action of the game and sends updates over WebSocket.

It is part of [Looters](https://github.com/Looters-it/looters), an online multiplayer conquest game played on real municipalities. This repository is not used on its own: it is cloned inside the root repository, which holds `docker-compose.yml`, the documentation and the instructions.

```sh
git clone https://github.com/Looters-it/looters.git && cd looters
git clone https://github.com/Looters-it/looters-api.git api
```

- Running, testing and commands: [README of the root repository](https://github.com/Looters-it/looters#readme)
- Contract between the services: [`docs/ARCHITECTURE.md`](https://github.com/Looters-it/looters/blob/main/docs/ARCHITECTURE.md)
- Rules of the game: [`docs/SPEC.md`](https://github.com/Looters-it/looters/blob/main/docs/SPEC.md)

Local checks: `pnpm lint && pnpm typecheck && pnpm test`.
