import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthGuard } from "../../auth/guard.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { RateLimiter } from "../../auth/rate-limit.js";
import type { SessionService } from "../../auth/sessions.js";
import { AppError } from "../../http/errors.js";

export interface AuthRoutesDeps {
  prisma: PrismaClient;
  sessions: SessionService;
  guard: AuthGuard;
  cookie: { name: string; secure: boolean };
  limits: { login: RateLimiter; register: RateLimiter };
}

const username = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[A-Za-z0-9_]+$/, "Username may contain only letters, digits and underscore");
const password = z.string().min(8).max(200);

// Strict on purpose: a body carrying `role` (or anything else) is rejected,
// so no registration path can ever create an admin.
const registerBody = z.strictObject({
  username,
  email: z.email().max(254),
  password,
  /**
   * The honeypot of the registration form: a field no person sees. Whatever
   * fills it is a programme, and is told that it worked while nothing is created.
   */
  contactTime: z.string().max(200).optional(),
});
const availabilityQuery = z.strictObject({ username });
const loginBody = z.strictObject({ username: z.string().max(100), password: z.string().max(200) });

/** Verified when the username does not exist, so that both cases take the same time. */
const DUMMY_HASH = await hashPassword("no-such-user");

const tooManyAttempts = (seconds: number) =>
  new AppError(429, "RATE_LIMITED", "Too many attempts, try again later", {
    "retry-after": String(seconds),
  });

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const { prisma, sessions, guard, cookie, limits } = deps;
  // One check per pause in typing: a person stays far below this.
  const availabilityLimit = new RateLimiter({ max: 40, windowMs: 60_000 });

  const startSession = async (request: FastifyRequest, reply: FastifyReply, userId: string) => {
    const { token, expiresAt } = await sessions.create(userId, {
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });
    reply.setCookie(cookie.name, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookie.secure,
      path: "/",
      expires: expiresAt,
    });
  };

  app.post("/api/auth/register", async (request, reply) => {
    const ipKey = `ip:${request.ip}`;
    const wait = limits.register.retryAfterSeconds(ipKey);
    if (wait > 0) throw tooManyAttempts(wait);
    limits.register.hit(ipKey);

    const body = registerBody.parse(request.body);
    if (body.contactTime) {
      request.log.warn({ event: "honeypot", route: "register" }, "registration by a programme");
      // The answer of a registration that worked, without a user and without a session.
      return reply.code(201).send({ id: randomUUID(), username: body.username, role: "USER" });
    }
    try {
      const user = await prisma.user.create({
        data: {
          username: body.username,
          email: body.email,
          passwordHash: await hashPassword(body.password),
          // The role is never read from the request.
          role: "USER",
        },
        select: { id: true, username: true, role: true },
      });
      await startSession(request, reply, user.id);
      return await reply.code(201).send(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "USERNAME_TAKEN", "This username is already taken");
      }
      throw error;
    }
  });

  // Asked by the registration form while the name is being typed. It tells no more
  // than registering with that name would, and is counted per address all the same.
  app.get("/api/auth/username-available", async (request) => {
    const ipKey = `ip:${request.ip}`;
    const wait = availabilityLimit.retryAfterSeconds(ipKey);
    if (wait > 0) throw tooManyAttempts(wait);
    availabilityLimit.hit(ipKey);

    const query = availabilityQuery.parse(request.query);
    // Names differing only by case are the same name, as for the unique index.
    const taken = await prisma.user.findFirst({
      where: { username: { equals: query.username, mode: "insensitive" } },
      select: { id: true },
    });
    return { available: taken === null };
  });

  // Login is by username only: an email is never accepted as identifier.
  app.post("/api/auth/login", async (request, reply) => {
    const body = loginBody.parse(request.body);
    const keys = [`ip:${request.ip}`, `user:${body.username.toLowerCase()}`];
    const wait = Math.max(...keys.map((key) => limits.login.retryAfterSeconds(key)));
    if (wait > 0) throw tooManyAttempts(wait);

    // A bot is a user nobody can be: it is looked for like someone who does not exist.
    const user = await prisma.user.findFirst({
      where: { username: { equals: body.username, mode: "insensitive" }, isBot: false },
    });
    const valid = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, body.password);
    if (!user || !valid) {
      for (const key of keys) limits.login.hit(key);
      throw new AppError(401, "INVALID_CREDENTIALS", "Wrong username or password");
    }

    for (const key of keys) limits.login.reset(key);
    await startSession(request, reply, user.id);
    return { id: user.id, username: user.username, role: user.role };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const auth = await guard.optional(request);
    if (auth) {
      await sessions.revoke(auth.sessionId);
      request.log.info(
        { sessionId: auth.sessionId, userId: auth.user.id },
        "session ended by logout",
      );
    }
    reply.clearCookie(cookie.name, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request) => (await guard.user(request)).user);
}
