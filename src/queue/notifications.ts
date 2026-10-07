import pg from "pg";
import { z } from "zod";

/** Postgres channel on which `jobs` announces what it has committed. */
export const GAME_EVENTS_CHANNEL = "game_events";

const notificationSchema = z.object({
  matchId: z.string().nullable().default(null),
  kind: z.string(),
});

export type GameNotification = z.infer<typeof notificationSchema>;

export interface NotificationListener {
  stop(): Promise<void>;
}

interface ListenerOptions {
  databaseUrl: string;
  onNotification: (notification: GameNotification) => void;
  onError: (error: unknown) => void;
  reconnectMs?: number;
}

/** Parses a NOTIFY payload; returns null when it is not a valid notification. */
export function parseNotification(payload: string | undefined): GameNotification | null {
  if (!payload) return null;
  try {
    const result = notificationSchema.safeParse(JSON.parse(payload));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * LISTENs on the game events channel with a dedicated connection and
 * reconnects when it drops. Notifications sent while disconnected are lost:
 * consumers must treat them as hints and re-read state from the database.
 */
export function listenForNotifications(options: ListenerOptions): NotificationListener {
  const { databaseUrl, onNotification, onError, reconnectMs = 2000 } = options;
  let stopped = false;
  let client: pg.Client | null = null;
  let timer: NodeJS.Timeout | null = null;

  const scheduleReconnect = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, reconnectMs);
  };

  const connect = async () => {
    const current = new pg.Client({ connectionString: databaseUrl });
    client = current;
    current.on("notification", (message) => {
      const notification = parseNotification(message.payload);
      if (notification) onNotification(notification);
    });
    current.on("error", (error) => {
      onError(error);
      current.end().catch(() => undefined);
      scheduleReconnect();
    });
    try {
      await current.connect();
      await current.query(`LISTEN ${GAME_EVENTS_CHANNEL}`);
    } catch (error) {
      onError(error);
      current.end().catch(() => undefined);
      scheduleReconnect();
    }
  };

  void connect();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await client?.end().catch(() => undefined);
    },
  };
}
