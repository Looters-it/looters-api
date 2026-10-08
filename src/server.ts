import { buildApp } from "./app.js";
import { loadServerEnv } from "./config/env.js";
import { createPrisma } from "./db/prisma.js";
import { createBattleQueue } from "./queue/battles.js";
import { enqueueJob } from "./queue/jobs.js";
import { listenForNotifications } from "./queue/notifications.js";

const env = loadServerEnv();
const prisma = createPrisma(env.DATABASE_URL);

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
  logger: { level: env.LOG_LEVEL },
  trustProxy: env.TRUST_PROXY,
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
    if (notification.matchId) app.realtime.matchChanged(notification.matchId, notification.kind);
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

await app.listen({ port: env.PORT, host: env.HOST });

// Round trip through the queue: proves at startup that `jobs` consumes it.
await enqueueJob(prisma, "system.ping", { sentAt: new Date().toISOString() });
