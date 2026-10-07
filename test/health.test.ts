import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

function appWith(pingDatabase: () => Promise<void>, pongAt: Date | null = null) {
  return buildApp({
    health: { pingDatabase, lastJobsPongAt: () => pongAt, battleQueueConnected: () => true },
  });
}

describe("health routes", () => {
  it("reports liveness without touching the database", async () => {
    const app = appWith(() => Promise.reject(new Error("down")));
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports readiness and the last reply from jobs", async () => {
    const pongAt = new Date("2026-01-01T00:00:00.000Z");
    const response = await appWith(() => Promise.resolve(), pongAt).inject("/api/health/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      database: true,
      jobs: { lastPongAt: pongAt.toISOString() },
      battleQueue: true,
    });
  });

  it("answers 503 when the database is unreachable", async () => {
    const response = await appWith(() => Promise.reject(new Error("down"))).inject(
      "/api/health/ready",
    );
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ database: false });
  });

  it("uses the shared error shape for unknown routes", async () => {
    const response = await appWith(() => Promise.resolve()).inject("/api/nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });
});
