# looters-api

Il servizio che risponde al browser: Node.js e TypeScript con Fastify e Prisma. Possiede lo schema del database (PostgreSQL con PostGIS), valida ogni azione di gioco e invia gli aggiornamenti via WebSocket.

Fa parte di [Looters](https://github.com/Looters-it/looters), un gioco di conquista multigiocatore sui comuni italiani. Questo repository non si usa da solo: va clonato dentro il repository radice, che contiene `docker-compose.yml`, documentazione e istruzioni.

```sh
git clone https://github.com/Looters-it/looters.git && cd looters
git clone https://github.com/Looters-it/looters-api.git api
```

- Avvio, test e comandi: [README del repository radice](https://github.com/Looters-it/looters#readme)
- Contratto tra i servizi: [`docs/ARCHITECTURE.md`](https://github.com/Looters-it/looters/blob/main/docs/ARCHITECTURE.md)
- Regole del gioco: [`docs/SPEC.md`](https://github.com/Looters-it/looters/blob/main/docs/SPEC.md)

Controlli in locale: `pnpm lint && pnpm typecheck && pnpm test`.
