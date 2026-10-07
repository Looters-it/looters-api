import type { AddressInfo } from "node:net";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp, type AuthConfig } from "../src/app.js";
import { hashSessionToken } from "../src/auth/tokens.js";
import { createPrisma } from "../src/db/prisma.js";
import { CLOSE_SESSION_ENDED } from "../src/realtime/hub.js";
import { seedAdmin } from "../src/seed/admin.js";

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("authentication", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  const sockets: WebSocket[] = [];

  async function start(auth: Partial<AuthConfig> = {}) {
    app = await buildApp({
      prisma,
      auth,
      health: {
        pingDatabase: () => Promise.resolve(),
        lastJobsPongAt: () => null,
        battleQueueConnected: () => true,
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
  }

  beforeEach(async () => {
    await prisma.match.deleteMany();
    await prisma.user.deleteMany();
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await app.close();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const mario = { username: "mario_rossi", email: "mario@example.test", password: "password-123" };

  const post = (path: string, payload?: InjectOptions["payload"], cookie?: string) =>
    app.inject({ method: "POST", url: path, payload, headers: cookie ? { cookie } : {} });
  const get = (path: string, cookie?: string) =>
    app.inject({ method: "GET", url: path, headers: cookie ? { cookie } : {} });

  /** Registers (or logs in) and returns the session cookie as a request header. */
  async function sessionCookie(path: string, payload: InjectOptions["payload"]): Promise<string> {
    const response = await post(path, payload);
    const cookie = response.cookies.find((c) => c.name === "sid");
    if (!cookie) throw new Error(`no session cookie: ${response.statusCode} ${response.body}`);
    return `sid=${cookie.value}`;
  }

  /** Opens a socket and collects what the server sends. */
  async function connect(cookie?: string) {
    const { port } = app.server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: cookie ? { cookie } : {},
    });
    sockets.push(socket);
    const messages: { t: string; n?: number }[] = [];
    let closeCode: number | null = null;
    socket.on("message", (data) => {
      messages.push(JSON.parse((data as Buffer).toString("utf8")) as { t: string; n?: number });
    });
    socket.on("close", (code) => {
      closeCode = code;
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return { socket, messages, closeCode: () => closeCode };
  }

  const until = (condition: () => boolean) =>
    expect.poll(condition, { timeout: 3000, interval: 10 }).toBe(true);

  describe("registration", () => {
    it("creates a normal user, starts a session and stores only hashes", async () => {
      await start();
      const response = await post("/api/auth/register", mario);

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ username: "mario_rossi", role: "USER" });
      const cookie = response.cookies.find((c) => c.name === "sid");
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });

      const user = await prisma.user.findFirstOrThrow({ include: { sessions: true } });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.sessions).toHaveLength(1);
      // The database holds the hash of the token, never the token itself.
      expect(user.sessions[0]?.tokenHash).toBe(hashSessionToken(cookie?.value ?? ""));
      expect(user.sessions[0]?.tokenHash).not.toBe(cookie?.value);
    });

    it("lets two users share an email", async () => {
      await start();
      expect((await post("/api/auth/register", mario)).statusCode).toBe(201);
      const second = await post("/api/auth/register", { ...mario, username: "luigi" });
      expect(second.statusCode).toBe(201);
      expect(await prisma.user.count({ where: { email: mario.email } })).toBe(2);
    });

    it("refuses a username already taken, whatever its case", async () => {
      await start();
      await post("/api/auth/register", mario);
      for (const username of ["mario_rossi", "Mario_Rossi"]) {
        const response = await post("/api/auth/register", { ...mario, username });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: { code: "USERNAME_TAKEN" } });
      }
    });

    it("validates the input", async () => {
      await start();
      const invalid = [
        { ...mario, username: "ab" },
        { ...mario, username: "mario rossi" },
        { ...mario, email: "not-an-email" },
        { ...mario, password: "short" },
        { username: mario.username, password: mario.password },
      ];
      for (const body of invalid) {
        const response = await post("/api/auth/register", body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "VALIDATION" } });
      }
      expect(await prisma.user.count()).toBe(0);
    });

    it("can never create an admin", async () => {
      await start();
      const response = await post("/api/auth/register", { ...mario, role: "ADMIN" });
      expect(response.statusCode).toBe(400);
      expect(await prisma.user.count()).toBe(0);
    });
  });

  describe("login", () => {
    it("accepts the username, in any case, and the password", async () => {
      await start();
      await post("/api/auth/register", mario);
      for (const username of ["mario_rossi", "MARIO_ROSSI"]) {
        const response = await post("/api/auth/login", { username, password: mario.password });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ username: "mario_rossi", role: "USER" });
      }
    });

    it("never accepts the email as identifier", async () => {
      await start();
      await post("/api/auth/register", mario);
      const response = await post("/api/auth/login", {
        username: mario.email,
        password: mario.password,
      });
      expect(response.statusCode).toBe(401);
    });

    it("gives the same answer for a wrong password and an unknown user", async () => {
      await start();
      await post("/api/auth/register", mario);
      const wrong = await post("/api/auth/login", { username: mario.username, password: "nope" });
      const unknown = await post("/api/auth/login", { username: "nobody", password: "nope" });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.json()).toEqual(unknown.json());
      expect(wrong.cookies).toHaveLength(0);
    });

    it("lets the seeded admin in", async () => {
      await start();
      await seedAdmin(prisma, {
        username: "admin",
        email: "a@example.test",
        password: "x".repeat(12),
      });
      const response = await post("/api/auth/login", {
        username: "admin",
        password: "x".repeat(12),
      });
      expect(response.json()).toMatchObject({ role: "ADMIN" });
    });
  });

  describe("sessions", () => {
    it("identifies the user from the cookie", async () => {
      await start();
      const cookie = await sessionCookie("/api/auth/register", mario);
      expect((await get("/api/auth/me", cookie)).json()).toMatchObject({ username: "mario_rossi" });
      expect((await get("/api/auth/me")).statusCode).toBe(401);
      expect((await get("/api/auth/me", "sid=forged")).statusCode).toBe(401);
    });

    it("ends the session on logout", async () => {
      await start();
      const cookie = await sessionCookie("/api/auth/register", mario);
      const response = await post("/api/auth/logout", undefined, cookie);
      expect(response.statusCode).toBe(204);
      expect(response.cookies.find((c) => c.name === "sid")?.value).toBe("");
      expect((await get("/api/auth/me", cookie)).statusCode).toBe(401);
    });

    it("stops accepting an expired session", async () => {
      await start();
      const cookie = await sessionCookie("/api/auth/register", mario);
      await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await get("/api/auth/me", cookie)).statusCode).toBe(401);
    });
  });

  describe("rate limiting", () => {
    it("blocks login after repeated failures, for that username from any address", async () => {
      await start({ loginRateLimit: { max: 3, windowMs: 60_000 } });
      await post("/api/auth/register", mario);
      const attempt = (password: string, ip: string) =>
        app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: mario.username, password },
          remoteAddress: ip,
        });

      for (let i = 0; i < 3; i++) expect((await attempt("wrong", "10.0.0.1")).statusCode).toBe(401);

      const blocked = await attempt(mario.password, "10.0.0.2");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("does not count successful logins", async () => {
      await start({ loginRateLimit: { max: 2, windowMs: 60_000 } });
      await post("/api/auth/register", mario);
      for (let i = 0; i < 5; i++) {
        const response = await post("/api/auth/login", {
          username: mario.username,
          password: mario.password,
        });
        expect(response.statusCode).toBe(200);
      }
    });

    it("blocks registration after too many attempts from one address", async () => {
      await start({ registerRateLimit: { max: 2, windowMs: 60_000 } });
      expect((await post("/api/auth/register", mario)).statusCode).toBe(201);
      expect((await post("/api/auth/register", { ...mario, username: "luigi" })).statusCode).toBe(
        201,
      );
      const blocked = await post("/api/auth/register", { ...mario, username: "peach" });
      expect(blocked.statusCode).toBe(429);
      expect(await prisma.user.count()).toBe(2);
    });
  });

  describe("online counter and revocation", () => {
    it("counts connected users and tells every socket, guests included", async () => {
      await start();
      const guest = await connect();
      await until(() => guest.messages.length === 1);
      expect(guest.messages[0]).toEqual({ t: "online", n: 0 });

      const cookie = await sessionCookie("/api/auth/register", mario);
      const player = await connect(cookie);
      await until(() => guest.messages.at(-1)?.n === 1);
      expect((await get("/api/stats/online")).json()).toEqual({ online: 1 });

      player.socket.close();
      await until(() => guest.messages.at(-1)?.n === 0);
    });

    it("treats a socket with an invalid cookie as a guest", async () => {
      await start();
      await connect("sid=forged");
      expect((await get("/api/stats/online")).json()).toEqual({ online: 0 });
    });

    it("lets only an admin list and revoke sessions", async () => {
      await start();
      const cookie = await sessionCookie("/api/auth/register", mario);
      expect((await get("/api/admin/sessions")).statusCode).toBe(401);
      expect((await get("/api/admin/sessions", cookie)).statusCode).toBe(403);
      const session = await prisma.session.findFirstOrThrow();
      const response = await app.inject({
        method: "DELETE",
        url: `/api/admin/sessions/${session.id}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(403);
      expect((await get("/api/auth/me", cookie)).statusCode).toBe(200);
    });

    it("disconnects a revoked session at once and stops accepting it", async () => {
      await start();
      await seedAdmin(prisma, {
        username: "admin",
        email: "a@example.test",
        password: "x".repeat(12),
      });
      const adminCookie = await sessionCookie("/api/auth/login", {
        username: "admin",
        password: "x".repeat(12),
      });
      const cookie = await sessionCookie("/api/auth/register", mario);
      const player = await connect(cookie);
      const guest = await connect();
      await until(() => guest.messages.at(-1)?.n === 1);

      const list = (await get("/api/admin/sessions", adminCookie)).json<
        { id: string; connected: boolean; current: boolean; user: { username: string } }[]
      >();
      expect(JSON.stringify(list)).not.toContain("tokenHash");
      const target = list.find((s) => s.user.username === "mario_rossi");
      expect(target).toMatchObject({ connected: true, current: false });

      const revoke = await app.inject({
        method: "DELETE",
        url: `/api/admin/sessions/${target?.id}`,
        headers: { cookie: adminCookie },
      });
      expect(revoke.statusCode).toBe(204);

      await until(() => player.closeCode() === CLOSE_SESSION_ENDED);
      expect(player.messages.at(-1)).toEqual({ t: "session.revoked" });
      expect((await get("/api/auth/me", cookie)).statusCode).toBe(401);
      await until(() => guest.messages.at(-1)?.n === 0);

      // Revoking it again finds nothing.
      const again = await app.inject({
        method: "DELETE",
        url: `/api/admin/sessions/${target?.id}`,
        headers: { cookie: adminCookie },
      });
      expect(again.statusCode).toBe(404);
    });

    it("disconnects the sockets of a session that logs out", async () => {
      await start();
      const cookie = await sessionCookie("/api/auth/register", mario);
      const player = await connect(cookie);
      await post("/api/auth/logout", undefined, cookie);
      await until(() => player.closeCode() === CLOSE_SESSION_ENDED);
    });
  });
});
