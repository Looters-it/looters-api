import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Job types and their payloads: the contract with the `jobs` service (docs/ARCHITECTURE.md).
 * This table carries scheduled and one-off work; battle resolution travels on Kafka (battles.ts).
 */
export interface JobPayloads {
  "system.ping": { sentAt: string };
  "geo.process": { uploadId: string };
  "match.start": { matchId: string };
  "turn.close": { matchId: string; turn: number };
  "empire.abandon": { matchId: string; empireId: string };
}

export type JobType = keyof JobPayloads;

export interface EnqueueOptions {
  /** When the job becomes eligible; defaults to now. */
  runAt?: Date;
  /** Idempotency key: enqueueing the same key twice keeps only the first job. */
  dedupeKey?: string;
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Moves the closing of a turn to the new moment the turn ends. If the job already came
 * by, and left the turn open because it was not time, another one is queued.
 */
export async function moveTurnClose(db: Db, matchId: string, turn: number, at: Date) {
  const key = `turn.close:${matchId}:${turn}`;
  const moved = await db.job.updateMany({
    where: { type: "turn.close", status: "PENDING", dedupeKey: { startsWith: key } },
    data: { runAt: at },
  });
  if (moved.count === 0) {
    await enqueueJob(
      db,
      "turn.close",
      { matchId, turn },
      { runAt: at, dedupeKey: `${key}:${at.getTime()}` },
    );
  }
}

/**
 * Adds a job to the queue table read by `jobs`. Pass a transaction client to
 * enqueue atomically with the change that needs the job.
 * Returns false when a job with the same dedupeKey already exists.
 */
export async function enqueueJob<T extends JobType>(
  db: Db,
  type: T,
  payload: JobPayloads[T],
  options: EnqueueOptions = {},
): Promise<boolean> {
  const { count } = await db.job.createMany({
    data: [{ type, payload, runAt: options.runAt, dedupeKey: options.dedupeKey }],
    skipDuplicates: true,
  });
  return count === 1;
}
