import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { AuthGuard } from "../auth/guard.js";
import type { AuthContext } from "../auth/sessions.js";
import { z } from "zod";
import type { Connection, RealtimeHub } from "./hub.js";

const clientMessage = z.object({
  t: z.enum(["sub", "unsub"]),
  matchId: z.string().min(1).max(64),
});

function parseJson(data: Buffer): unknown {
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
}

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
  /** Whether a user has an empire still in play in a match. */
  isPlayer: (matchId: string, userId: string) => Promise<boolean>,
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

      const connection: Connection = {
        userId: auth?.user.id ?? null,
        sessionId: auth?.sessionId ?? null,
        expiresAt: auth?.expiresAt ?? null,
        send: (data) => {
          if (socket.readyState === socket.OPEN) socket.send(data);
        },
        close: (code, reason) => {
          socket.close(code, reason);
        },
      };
      const remove = hub.add(connection);

      // Client messages: {t:"sub",matchId} and {t:"unsub",matchId}.
      socket.on("message", (data: Buffer) => {
        const message = clientMessage.safeParse(parseJson(data));
        if (!message.success) return;
        const { t, matchId } = message.data;
        if (t === "unsub") {
          hub.unsubscribe(connection, matchId);
          return;
        }
        const userId = auth?.user.id;
        void (userId ? isPlayer(matchId, userId) : Promise.resolve(false))
          .then((player) => {
            if (socket.readyState === socket.OPEN) hub.subscribe(connection, matchId, player);
          })
          .catch((error: unknown) => {
            request.log.error({ err: error }, "match subscription failed");
          });
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
