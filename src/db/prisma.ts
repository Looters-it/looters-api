import { PrismaClient } from "@prisma/client";

/**
 * `poolSize`: how many connections to the database the client keeps. Every
 * action of the game is a transaction that holds one for its whole length, so
 * with many players at once this is what requests queue on.
 */
export function createPrisma(databaseUrl: string, poolSize?: number): PrismaClient {
  const url = new URL(databaseUrl);
  if (poolSize !== undefined) url.searchParams.set("connection_limit", String(poolSize));
  return new PrismaClient({ datasourceUrl: url.toString() });
}

export type { PrismaClient };
