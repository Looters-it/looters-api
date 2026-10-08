import { Writable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

type Line = Record<string, unknown>;

async function appWithLogs() {
  const lines: Line[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Line);
      done();
    },
  });
  // These routes never touch the database client.
  const app = await buildApp({
    prisma: {} as PrismaClient,
    logger: { level: "info", stream },
    health: {
      pingDatabase: () => Promise.resolve(),
      lastJobsPongAt: () => null,
      battleQueueConnected: () => true,
    },
  });
  app.get("/api/matches/:id/boom", () => {
    throw new Error("nobody foresaw this");
  });
  const events = (event: string) => lines.filter((line) => line.event === event);
  return { app, lines, events };
}

describe("structured logs", () => {
  it("writes one line per answered request, with the route pattern and not the raw url", async () => {
    const { app, events } = await appWithLogs();
    const response = await app.inject("/api/health/ready?probe=1");

    const [line] = events("request");
    expect(events("request")).toHaveLength(1);
    expect(line).toMatchObject({
      method: "GET",
      route: "/api/health/ready",
      status: 200,
      userId: null,
      matchId: null,
    });
    expect(typeof line?.ms).toBe("number");
    // The same id is in the line and in the answer.
    expect(response.headers["x-request-id"]).toBe(line?.reqId);
  });

  it("gives every request its own id and never takes one from the client", async () => {
    const { app } = await appWithLogs();
    const ids = new Set<unknown>();
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        url: "/api/health/ready",
        headers: { "x-request-id": "chosen-by-the-client" },
      });
      ids.add(response.headers["x-request-id"]);
    }
    expect(ids.size).toBe(3);
    expect(ids.has("chosen-by-the-client")).toBe(false);
  });

  it("stays silent on the liveness probe and names unknown routes without their path", async () => {
    const { app, events } = await appWithLogs();
    await app.inject("/api/health");
    expect(events("request")).toHaveLength(0);

    await app.inject("/api/secret-looking/123456");
    expect(events("request")[0]).toMatchObject({ status: 404 });
    expect(JSON.stringify(events("request")[0])).not.toContain("123456");
  });

  it("logs an unforeseen failure with its stack and hands the request id to the client", async () => {
    const { app, events } = await appWithLogs();
    const response = await app.inject("/api/matches/m42/boom");

    expect(response.statusCode).toBe(500);
    const body = response.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error).toEqual({
      code: "INTERNAL",
      message: "Internal error",
      requestId: response.headers["x-request-id"],
    });
    // Nothing about the failure leaks to the client.
    expect(response.body).not.toContain("nobody foresaw");

    const [failure] = events("unhandled_error");
    expect(failure).toMatchObject({
      reqId: body.error.requestId,
      route: "/api/matches/:id/boom",
      level: 50,
    });
    expect((failure?.err as { stack: string }).stack).toContain("nobody foresaw this");
    expect(events("request")[0]).toMatchObject({ status: 500, matchId: "m42", level: 50 });
  });

  it("does not log the errors a client is expected to make as failures", async () => {
    const { app, events } = await appWithLogs();
    const response = await app.inject({ method: "POST", url: "/api/matches", payload: {} });
    expect(response.statusCode).toBe(401);
    expect(events("unhandled_error")).toHaveLength(0);
    expect(events("request")[0]).toMatchObject({ status: 401, level: 30 });
  });

  describe("errors of the web interface", () => {
    const report = (app: Awaited<ReturnType<typeof appWithLogs>>["app"], payload: object) =>
      app.inject({ method: "POST", url: "/api/client-errors", payload });

    it("are logged as warnings", async () => {
      const { app, events } = await appWithLogs();
      const response = await report(app, {
        message: "x is undefined",
        stack: "at Map (map.js:1)",
        path: "/partite/m1",
        kind: "render",
      });
      expect(response.statusCode).toBe(204);
      expect(events("client_error")[0]).toMatchObject({
        level: 40,
        message: "x is undefined",
        path: "/partite/m1",
        kind: "render",
      });
    });

    it("ignore what is not a report and stop listening to an address that floods", async () => {
      const { app, events } = await appWithLogs();
      expect((await report(app, { message: "x".repeat(5000) })).statusCode).toBe(204);
      expect((await report(app, { nothing: true })).statusCode).toBe(204);
      expect(events("client_error")).toHaveLength(0);

      for (let i = 0; i < 40; i++) await report(app, { message: `error ${String(i)}` });
      // Two attempts were already spent above.
      expect(events("client_error")).toHaveLength(18);
    });
  });
});
