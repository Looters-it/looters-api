import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthGuard } from "../../auth/guard.js";
import type { SessionService } from "../../auth/sessions.js";
import { notFound } from "../../http/errors.js";
import type { RealtimeHub } from "../../realtime/hub.js";

export interface AdminRoutesDeps {
  prisma: PrismaClient;
  sessions: SessionService;
  guard: AuthGuard;
  hub: RealtimeHub;
}

const sessionParams = z.object({ id: z.string().min(1) });

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  const { prisma, sessions, guard, hub } = deps;

  app.get("/api/admin/stats", async (request) => {
    await guard.admin(request);
    const [users, matchesRunning] = await Promise.all([
      prisma.user.count({ where: { role: "USER" } }),
      prisma.match.count({ where: { status: "RUNNING" } }),
    ]);
    return { users, matchesRunning, online: hub.onlineCount() };
  });

  // Active sessions; the token hash never leaves the database.
  app.get("/api/admin/sessions", async (request) => {
    const auth = await guard.admin(request);
    const active = await sessions.listActive();
    return active.map((session) => ({
      ...session,
      connected: hub.isSessionConnected(session.id),
      current: session.id === auth.sessionId,
    }));
  });

  // Revokes a session: it stops being valid and its sockets are closed at once.
  app.delete("/api/admin/sessions/:id", async (request, reply) => {
    const auth = await guard.admin(request);
    const { id } = sessionParams.parse(request.params);
    if (!(await sessions.revoke(id))) throw notFound("Session");
    request.log.info({ sessionId: id, byUserId: auth.user.id }, "session revoked by admin");
    return reply.code(204).send();
  });
}
