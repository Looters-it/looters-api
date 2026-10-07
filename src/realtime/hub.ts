/** Close code sent when the session behind a socket is revoked or has expired. */
export const CLOSE_SESSION_ENDED = 4401;

/** Messages the server pushes to clients (docs/ARCHITECTURE.md, WebSocket). */
export type ServerMessage = { t: "online"; n: number } | { t: "session.revoked" };

/** One open socket, authenticated or anonymous. */
export interface Connection {
  userId: string | null;
  sessionId: string | null;
  expiresAt: Date | null;
  send(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * Tracks the open sockets of this process. "Online" means distinct users
 * with a valid session and at least one open socket (PROMPT §5).
 */
export class RealtimeHub {
  private readonly connections = new Set<Connection>();
  private lastOnline = 0;

  /** Registers a socket, tells it the current count, and returns its removal function. */
  add(connection: Connection): () => void {
    this.connections.add(connection);
    connection.send(JSON.stringify({ t: "online", n: this.onlineCount() } satisfies ServerMessage));
    this.announceIfChanged();
    return () => {
      if (this.connections.delete(connection)) this.announceIfChanged();
    };
  }

  onlineCount(): number {
    const users = new Set<string>();
    for (const connection of this.connections) {
      if (connection.userId) users.add(connection.userId);
    }
    return users.size;
  }

  /** Whether the session has at least one open socket. */
  isSessionConnected(sessionId: string): boolean {
    for (const connection of this.connections) {
      if (connection.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Disconnects every socket of a session that has just been revoked. */
  closeSession(sessionId: string): void {
    this.closeWhere((connection) => connection.sessionId === sessionId);
  }

  /** Disconnects the sockets whose session has expired. */
  closeExpired(now: Date): void {
    this.closeWhere((connection) => connection.expiresAt !== null && connection.expiresAt <= now);
  }

  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const connection of this.connections) connection.send(data);
  }

  private closeWhere(matches: (connection: Connection) => boolean): void {
    let closed = false;
    for (const connection of [...this.connections]) {
      if (!matches(connection)) continue;
      this.connections.delete(connection);
      connection.send(JSON.stringify({ t: "session.revoked" } satisfies ServerMessage));
      connection.close(CLOSE_SESSION_ENDED, "session ended");
      closed = true;
    }
    if (closed) this.announceIfChanged();
  }

  private announceIfChanged(): void {
    const online = this.onlineCount();
    if (online === this.lastOnline) return;
    this.lastOnline = online;
    this.broadcast({ t: "online", n: online });
  }
}
