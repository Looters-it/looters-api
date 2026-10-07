import type { FastifyInstance } from "fastify";
import type { RealtimeHub } from "../../realtime/hub.js";

export function registerStatsRoutes(app: FastifyInstance, hub: RealtimeHub): void {
  // Public: the same number pushed over WebSocket as `{t:"online"}`.
  app.get("/api/stats/online", () => ({ online: hub.onlineCount() }));
}
