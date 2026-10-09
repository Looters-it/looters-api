import type { PrismaClient, Role } from "@prisma/client";
import { generateSessionToken, hashSessionToken } from "./tokens.js";

export interface AuthContext {
  sessionId: string;
  expiresAt: Date;
  /** True when this very request pushed the expiry forward: the cookie must follow. */
  renewed?: boolean;
  user: { id: string; username: string; role: Role };
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * How stale `lastSeenAt` may get before a request refreshes it. The expiry is
 * pushed forward at the same pace: a session lasts its whole length from the
 * last time it was used, not from the login.
 */
const LAST_SEEN_RESOLUTION_MS = 60_000;

/**
 * Server-side sessions: one row per login. The client holds the token in an
 * httpOnly cookie; the database holds only its hash, so reading the database
 * does not let anyone reuse a session.
 */
export class SessionService {
  /** Called after a session is revoked, to drop its live connections. */
  onRevoked: (sessionId: string) => void = () => undefined;
  /** Called when a session in use lives longer, for whatever keeps its expiry. */
  onRenewed: (sessionId: string, expiresAt: Date) => void = () => undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Starts a session and returns the token to hand to the client, once. */
  async create(
    userId: string,
    meta: SessionMeta = {},
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = generateSessionToken();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs);
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300),
      },
    });
    return { token, expiresAt };
  }

  /**
   * The session behind a token, or null when it is unknown, revoked or expired.
   * Using a session renews it.
   */
  async resolve(token: string | undefined): Promise<AuthContext | null> {
    if (!token) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: { select: { id: true, username: true, role: true } } },
    });
    const now = this.now();
    if (!session || session.revokedAt || session.expiresAt <= now) return null;

    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
      const expiresAt = new Date(now.getTime() + this.ttlMs);
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now, expiresAt },
      });
      this.onRenewed(session.id, expiresAt);
      return { sessionId: session.id, expiresAt, renewed: true, user: session.user };
    }
    return { sessionId: session.id, expiresAt: session.expiresAt, user: session.user };
  }

  /** Revokes a session at once. Returns false when there was nothing to revoke. */
  async revoke(sessionId: string): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    if (count === 0) return false;
    this.onRevoked(sessionId);
    return true;
  }

  /** Revokes every other session of a user: after a change of password. Returns how many. */
  async revokeOthers(userId: string, keepSessionId: string): Promise<number> {
    const others = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, id: { not: keepSessionId } },
      select: { id: true },
    });
    let ended = 0;
    for (const session of others) if (await this.revoke(session.id)) ended += 1;
    return ended;
  }

  /** Sessions that are still usable, most recently seen first. */
  listActive() {
    return this.prisma.session.findMany({
      where: { revokedAt: null, expiresAt: { gt: this.now() } },
      orderBy: { lastSeenAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        ip: true,
        userAgent: true,
        user: { select: { id: true, username: true, role: true } },
      },
    });
  }
}
