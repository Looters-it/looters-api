/**
 * Says again which municipalities are islands and which exclaves (see
 * `src/modules/geo/isolation.ts`). The api does it by itself when it starts and after
 * an upload: this is for doing it by hand, after borders were changed in the database.
 *
 *   pnpm areas:classify
 */
import { PrismaClient } from "@prisma/client";
import { classifyIsolated } from "../src/modules/geo/isolation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const changed = await classifyIsolated(prisma);
const found = await prisma.$queryRaw<{ isolation: string; count: number }[]>`
  SELECT isolation::text, count(*)::int AS count FROM "GeoUnit"
  WHERE isolation IS NOT NULL GROUP BY isolation ORDER BY isolation`;
console.log(`${String(changed)} municipalities changed`);
console.table(found);
await prisma.$disconnect();
