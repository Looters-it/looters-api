import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";

function appWith(pingDatabase: () => Promise<void>, pongAt: Date | null = null) {
  // These routes never touch the database client.
  return buildApp({
    prisma: {} as PrismaClient,
    health: { pingDatabase, lastJobsPongAt: () => pongAt, battleQueueConnected: () => true },
  });
}

describe("health routes", () => {
  it("reports liveness without touching the database", async () => {
    const app = await appWith(() => Promise.reject(new Error("down")));
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports readiness and the last reply from jobs", async () => {
    const pongAt = new Date("2026-01-01T00:00:00.000Z");
    const app = await appWith(() => Promise.resolve(), pongAt);
    const response = await app.inject("/api/health/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      database: true,
      jobs: { lastPongAt: pongAt.toISOString() },
      battleQueue: true,
    });
  });

  it("answers 503 when the database is unreachable", async () => {
    const app = await appWith(() => Promise.reject(new Error("down")));
    const response = await app.inject("/api/health/ready");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ database: false });
  });

  it("uses the shared error shape for unknown routes", async () => {
    const app = await appWith(() => Promise.resolve());
    const response = await app.inject("/api/nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });
});
