/** Close code sent when the session behind a socket is revoked or has expired. */
export const CLOSE_SESSION_ENDED = 4401;

/** Messages the server pushes to clients (docs/ARCHITECTURE.md, WebSocket). */
export type ServerMessage =
  | { t: "online"; n: number }
  | { t: "session.revoked" }
  /** Something of the match changed: the client reads its state again. */
  | { t: "match.update"; matchId: string; kinds: string[] }
  /** Players of the match connected right now, out of those still in play. */
  | { t: "match.online"; matchId: string; connected: number }
  /** Sent only to the attacked player: an attack is waiting for an answer. */
  | { t: "battle.incoming"; matchId: string; battleId: string };

/** One open socket, authenticated or anonymous. */
export interface Connection {
  userId: string | null;
  sessionId: string | null;
  expiresAt: Date | null;
  send(data: string): void;
  close(code: number, reason: string): void;
  /**
   * Matches this socket follows; the value says whether its user plays in
   * the match (has an active empire), which is what the match counter counts.
   */
  matches?: Map<string, boolean>;
}

/**
 * Tracks the open sockets of this process. "Online" means distinct users
 * with a valid session and at least one open socket (PROMPT §5).
 */
export class RealtimeHub {
  private readonly connections = new Set<Connection>();
  private lastOnline = 0;
  /** Matches whose followers were told of a change within the window, and what came after. */
  private readonly quiet = new Map<string, { timer: NodeJS.Timeout; kinds: Set<string> }>();

  /**
   * `updateWindowMs`: at most one `match.update` per match in this time. Every
   * follower answers one by reading the state again, so a hundred players
   * acting at once would otherwise make each of them read it a hundred times.
   * The first change is told at once; those that follow within the window are
   * told together when it ends. Zero tells every change as it happens.
   */
  constructor(private readonly updateWindowMs = 0) {}

  /** Drops what is waiting to be told: for when the server stops. */
  stop(): void {
    for (const { timer } of this.quiet.values()) clearTimeout(timer);
    this.quiet.clear();
  }

  /** Registers a socket, tells it the current count, and returns its removal function. */
  add(connection: Connection): () => void {
    this.connections.add(connection);
    connection.send(JSON.stringify({ t: "online", n: this.onlineCount() } satisfies ServerMessage));
    this.announceIfChanged();
    return () => {
      if (!this.connections.delete(connection)) return;
      this.announceIfChanged();
      for (const matchId of connection.matches?.keys() ?? []) this.announceMatch(matchId);
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

  // ---------- Matches ----------

  /** Starts sending the socket what happens in a match. */
  subscribe(connection: Connection, matchId: string, isPlayer: boolean): void {
    (connection.matches ??= new Map()).set(matchId, isPlayer);
    this.announceMatch(matchId);
  }

  unsubscribe(connection: Connection, matchId: string): void {
    if (connection.matches?.delete(matchId)) this.announceMatch(matchId);
  }

  /** Distinct players of the match that are watching it right now. */
  matchOnline(matchId: string): number {
    const users = new Set<string>();
    for (const connection of this.connections) {
      if (connection.userId && connection.matches?.get(matchId)) users.add(connection.userId);
    }
    return users.size;
  }

  /** Sends a message to every socket that follows the match. */
  publish(matchId: string, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const connection of this.connections) {
      if (connection.matches?.has(matchId)) connection.send(data);
    }
  }

  /** Sends a message to the sockets of one user that follow the match. */
  publishToUser(matchId: string, userId: string, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const connection of this.connections) {
      if (connection.userId === userId && connection.matches?.has(matchId)) connection.send(data);
    }
  }

  /** Tells the followers of a match that it changed. `kinds` hints at what. */
  matchChanged(matchId: string, ...kinds: string[]): void {
    if (this.updateWindowMs <= 0) {
      this.publish(matchId, { t: "match.update", matchId, kinds });
      return;
    }
    const waiting = this.quiet.get(matchId);
    if (waiting) {
      for (const kind of kinds) waiting.kinds.add(kind);
      return;
    }
    this.publish(matchId, { t: "match.update", matchId, kinds });
    this.openWindow(matchId);
  }

  private openWindow(matchId: string): void {
    const timer = setTimeout(() => {
      const kinds = [...(this.quiet.get(matchId)?.kinds ?? [])];
      this.quiet.delete(matchId);
      if (kinds.length === 0) return;
      this.publish(matchId, { t: "match.update", matchId, kinds });
      this.openWindow(matchId);
    }, this.updateWindowMs);
    timer.unref();
    this.quiet.set(matchId, { timer, kinds: new Set() });
  }

  private readonly lastMatchOnline = new Map<string, number>();
  private announceMatch(matchId: string): void {
    const connected = this.matchOnline(matchId);
    if (this.lastMatchOnline.get(matchId) === connected) return;
    this.lastMatchOnline.set(matchId, connected);
    this.publish(matchId, { t: "match.online", matchId, connected });
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
      for (const matchId of connection.matches?.keys() ?? []) this.announceMatch(matchId);
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
