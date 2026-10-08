import cookie from "@fastify/cookie";
import type { PrismaClient } from "@prisma/client";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createAuthGuard } from "./auth/guard.js";
import { RateLimiter, type RateLimitRule } from "./auth/rate-limit.js";
import { SessionService } from "./auth/sessions.js";
import { registerErrorHandling } from "./http/errors.js";
import { loggingServerOptions, registerRequestLogging } from "./http/logging.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerGeoAdminRoutes } from "./modules/geo/admin-routes.js";
import { registerGeoPublicRoutes } from "./modules/geo/public-routes.js";
import { TileCache } from "./modules/geo/tile-cache.js";
import { registerHealthRoutes, type HealthDeps } from "./modules/health/routes.js";
import { registerBoardRoutes } from "./modules/board/routes.js";
import { BoardService } from "./modules/board/service.js";
import { AllianceService } from "./modules/game/alliances.js";
import { BattleService, type ResolutionQueue } from "./modules/game/battles.js";
import { registerGameRoutes } from "./modules/game/routes.js";
import { GameService } from "./modules/game/service.js";
import { StructureService } from "./modules/game/structures.js";
import { registerMatchRoutes } from "./modules/matches/routes.js";
import { MatchService } from "./modules/matches/service.js";
import { registerStatsRoutes } from "./modules/stats/routes.js";
import { BotRunner } from "./modules/bots/runner.js";
import { BotService } from "./modules/bots/service.js";
import { RealtimeHub } from "./realtime/hub.js";
import { registerWebSocket } from "./realtime/ws.js";

declare module "fastify" {
  interface FastifyInstance {
    realtime: RealtimeHub;
    /** For changes made outside this process (by `jobs`): same effect as one made here. */
    matchChanged: (matchId: string, kind: string) => void;
    bots: BotService;
    wakeBots: () => Promise<void>;
  }
}

export interface AuthConfig {
  cookieName: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  loginRateLimit: RateLimitRule;
  registerRateLimit: RateLimitRule;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  cookieName: "sid",
  cookieSecure: false,
  sessionTtlHours: 720,
  loginRateLimit: { max: 10, windowMs: 5 * 60_000 },
  registerRateLimit: { max: 10, windowMs: 60 * 60_000 },
};

export interface AppDeps {
  prisma: PrismaClient;
  health: HealthDeps;
  auth?: Partial<AuthConfig>;
  /** Where geo files are stored (shared with `jobs`) and how large one may be. */
  uploads?: { dir: string; maxMegabytes: number };
  /** Where battles are handed to `jobs` for resolution; a no-op when omitted (tests). */
  battleQueue?: ResolutionQueue;
  /** Memory given to generated map tiles. */
  tileCacheMegabytes?: number;
  /** At most one "the match changed" push per match in this time; 0 pushes every change. */
  matchUpdateWindowMs?: number;
  /** The state of a match read once for all its viewers within this time; 0 disables it. */
  matchStateCacheMs?: number;
  /** Lets bots act by themselves when turns begin and attacks arrive. */
  runBots?: boolean;
  logger?: FastifyServerOptions["logger"];
  /** True behind the web proxy, so that the client address is read from X-Forwarded-For. */
  trustProxy?: boolean;
}

/** Builds the HTTP application without starting it, so tests can inject requests. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const auth = { ...DEFAULT_AUTH_CONFIG, ...deps.auth };
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
    ...loggingServerOptions(),
  });

  registerErrorHandling(app);
  registerRequestLogging(app);
  await app.register(cookie);

  const hub = new RealtimeHub(deps.matchUpdateWindowMs ?? 0);
  app.addHook("onClose", () => {
    hub.stop();
  });
  const sessions = new SessionService(deps.prisma, auth.sessionTtlHours * 3_600_000);
  sessions.onRevoked = (sessionId) => {
    hub.closeSession(sessionId);
  };
  const guard = createAuthGuard(sessions, auth.cookieName);

  registerHealthRoutes(app, deps.health);
  registerAuthRoutes(app, {
    prisma: deps.prisma,
    sessions,
    guard,
    cookie: { name: auth.cookieName, secure: auth.cookieSecure },
    limits: {
      login: new RateLimiter(auth.loginRateLimit),
      register: new RateLimiter(auth.registerRateLimit),
    },
  });
  registerAdminRoutes(app, { prisma: deps.prisma, sessions, guard, hub });
  await registerGeoAdminRoutes(app, {
    prisma: deps.prisma,
    guard,
    uploadDir: deps.uploads?.dir ?? "./uploads",
    maxUploadBytes: (deps.uploads?.maxMegabytes ?? 300) * 1_048_576,
  });
  // One cache for every kind of tile: keys carry what they belong to.
  const tileCache = new TileCache((deps.tileCacheMegabytes ?? 64) * 1_048_576);
  registerGeoPublicRoutes(app, { prisma: deps.prisma, tileCache });
  const matches = new MatchService(deps.prisma);
  matches.stateCacheMs = deps.matchStateCacheMs ?? 0;
  // Whatever changes a match: its state is read anew and its followers are told.
  let botRunner: BotRunner | null = null;
  const matchChanged = (matchId: string, kind: string) => {
    matches.forget(matchId);
    hub.matchChanged(matchId, kind);
    botRunner?.matchChanged(matchId, kind);
  };
  matches.onChange = matchChanged;
  app.decorate("matchChanged", matchChanged);
  matches.matchOnline = (matchId) => hub.matchOnline(matchId);
  const game = new GameService(deps.prisma, matches);
  game.onChange = matches.onChange;
  registerMatchRoutes(app, { prisma: deps.prisma, guard, tileCache, service: matches });
  const battles = new BattleService(
    deps.prisma,
    matches,
    deps.battleQueue ?? { requestResolution: () => Promise.resolve() },
  );
  battles.onChange = matches.onChange;
  battles.onIncoming = (matchId, userId, battleId) => {
    hub.publishToUser(matchId, userId, { t: "battle.incoming", matchId, battleId });
  };
  battles.onQueueError = (error, battleId) => {
    // Not fatal: the battle is resolved, with the recorded answer, when the turn closes.
    app.log.error({ err: error, battleId }, "battle not handed to jobs");
  };
  const structures = new StructureService(deps.prisma, matches);
  structures.onChange = matches.onChange;
  const alliances = new AllianceService(deps.prisma, matches);
  alliances.onChange = matches.onChange;
  registerGameRoutes(app, game, battles, structures, alliances, guard);

  // Empires played by the server. They act only where the runner is on (not in tests,
  // which call the service themselves).
  const bots = new BotService(deps.prisma, matches, game, battles, structures, alliances);
  bots.onError = (error, context) => {
    app.log.error({ event: "bot_error", err: error, ...context }, "a bot failed");
  };
  app.decorate("bots", bots);
  if (deps.runBots) {
    botRunner = new BotRunner(bots);
    const runner = botRunner;
    app.addHook("onClose", () => {
      runner.stop();
    });
  }
  /** After a restart: the bots of the matches in progress play the turn they may have missed. */
  app.decorate("wakeBots", async () => {
    const running = await deps.prisma.match.findMany({
      where: { status: "RUNNING", config: { path: ["botsEnabled"], equals: true } },
      select: { id: true },
    });
    for (const match of running) botRunner?.matchChanged(match.id, "match.started");
  });
  const board = new BoardService(deps.prisma, matches);
  board.onChange = matches.onChange;
  registerBoardRoutes(app, board, guard);
  registerStatsRoutes(app, hub);
  await registerWebSocket(app, hub, guard, async (matchId, userId) => {
    const empires = await deps.prisma.empire.count({
      where: { matchId, userId, status: "ACTIVE" },
    });
    return empires > 0;
  });

  // What `jobs` announces (a turn closed, a match started) reaches the followers of the match.
  app.decorate("realtime", hub);

  return app;
}
