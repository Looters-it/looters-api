import { buildApp } from "./app.js";
import { loadServerEnv } from "./config/env.js";
import { createPrisma } from "./db/prisma.js";
import { REDACTED_PATHS } from "./http/logging.js";
import { createBattleQueue } from "./queue/battles.js";
import { enqueueJob } from "./queue/jobs.js";
import { listenForNotifications } from "./queue/notifications.js";

const env = loadServerEnv();
const prisma = createPrisma(env.DATABASE_URL, env.DATABASE_POOL_SIZE);

let lastJobsPongAt: Date | null = null;

const battleQueue = createBattleQueue({
  brokers: env.KAFKA_BROKERS,
  topic: env.KAFKA_BATTLE_TOPIC,
  onError: (error) => {
    app.log.warn({ err: error }, "battle queue not connected, retrying");
  },
});

const app = await buildApp({
  prisma,
  logger: { level: env.LOG_LEVEL, redact: REDACTED_PATHS },
  trustProxy: env.TRUST_PROXY,
  matchUpdateWindowMs: env.MATCH_UPDATE_WINDOW_MS,
  matchStateCacheMs: env.MATCH_STATE_CACHE_MS,
  runBots: true,
  uploads: { dir: env.UPLOAD_DIR, maxMegabytes: env.UPLOAD_MAX_MB },
  tileCacheMegabytes: env.TILE_CACHE_MB,
  battleQueue,
  auth: {
    cookieName: env.SESSION_COOKIE_NAME,
    cookieSecure: env.COOKIE_SECURE,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    loginRateLimit: { max: env.LOGIN_RATE_MAX, windowMs: env.LOGIN_RATE_WINDOW_SEC * 1000 },
    registerRateLimit: {
      max: env.REGISTER_RATE_MAX,
      windowMs: env.REGISTER_RATE_WINDOW_SEC * 1000,
    },
  },
  health: {
    pingDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
    lastJobsPongAt: () => lastJobsPongAt,
    battleQueueConnected: () => battleQueue.isConnected(),
  },
});

const listener = listenForNotifications({
  databaseUrl: env.DATABASE_URL,
  onNotification: (notification) => {
    if (notification.kind === "system.pong") {
      lastJobsPongAt = new Date();
      app.log.info("jobs service replied to ping");
    }
    // A turn closed or a match started: its followers read the state again.
    if (notification.matchId) app.matchChanged(notification.matchId, notification.kind);
  },
  onError: (error) => {
    app.log.error({ err: error }, "notification listener error");
  },
});

const shutdown = async () => {
  await app.close();
  await listener.stop();
  await battleQueue.close();
  await prisma.$disconnect();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().then(() => process.exit(0));
  });
}

// A failure outside any request: logged with its stack, then the process stops and the
// container restarts it, rather than carrying on in an unknown state.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error) => {
    app.log.fatal({ event: "process_crash", cause: event, err: error }, "fatal error");
    process.exit(1);
  });
}

await app.listen({ port: env.PORT, host: env.HOST });

await app.wakeBots();

// Round trip through the queue: proves at startup that `jobs` consumes it.
await enqueueJob(prisma, "system.ping", { sentAt: new Date().toISOString() });
