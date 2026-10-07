import { PrismaClient } from "@prisma/client";

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

export type { PrismaClient };
