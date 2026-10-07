import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { AuthGuard } from "../auth/guard.js";
import type { AuthContext } from "../auth/sessions.js";
import type { RealtimeHub } from "./hub.js";

declare module "fastify" {
  interface FastifyRequest {
    wsAuth?: AuthContext | null;
  }
}

const HEARTBEAT_MS = 30_000;

/**
 * `GET /ws`: authentication is optional (the public homepage listens for
 * the online count too) and comes from the session cookie of the handshake.
 */
export async function registerWebSocket(
  app: FastifyInstance,
  hub: RealtimeHub,
  guard: AuthGuard,
): Promise<void> {
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  app.get(
    "/ws",
    {
      websocket: true,
      // Resolve the session before the upgrade, so the handler can stay synchronous.
      preValidation: async (request) => {
        request.wsAuth = await guard.optional(request);
      },
    },
    (socket, request) => {
      const auth = request.wsAuth ?? null;
      let alive = true;

      const remove = hub.add({
        userId: auth?.user.id ?? null,
        sessionId: auth?.sessionId ?? null,
        expiresAt: auth?.expiresAt ?? null,
        send: (data) => {
          if (socket.readyState === socket.OPEN) socket.send(data);
        },
        close: (code, reason) => {
          socket.close(code, reason);
        },
      });

      // Drop sockets whose peer vanished without closing.
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, HEARTBEAT_MS);
      socket.on("pong", () => {
        alive = true;
      });

      socket.on("close", () => {
        clearInterval(heartbeat);
        remove();
      });
      socket.on("error", () => {
        socket.terminate();
      });
    },
  );

  // Sessions that reach their expiry while connected are disconnected too.
  const sweep = setInterval(() => {
    hub.closeExpired(new Date());
  }, 60_000);
  app.addHook("onClose", () => {
    clearInterval(sweep);
  });
}
