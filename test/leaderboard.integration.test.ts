import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import type { LeaderboardRow } from "../src/modules/leaderboard/routes.js";

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

interface Page {
  players: LeaderboardRow[];
  total: number;
  page: number;
  pageSize: number;
}

describe.skipIf(!url)("global ranking", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  let cookie = "";

  beforeEach(async () => {
    await prisma.job.deleteMany();
    await prisma.match.deleteMany();
    await prisma.user.deleteMany();
    app = await buildApp({
      prisma,
      auth: { registerRateLimit: { max: 1000, windowMs: 60_000 } },
      health: {
        pingDatabase: () => Promise.resolve(),
        lastJobsPongAt: () => null,
        battleQueueConnected: () => true,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "anna", email: "anna@example.test", password: "password-123" },
    });
    cookie = `sid=${response.cookies.find((c) => c.name === "sid")?.value ?? ""}`;
    // Anna has played; so have the others, a bot among them. Dario never finished a match.
    await prisma.user.update({
      where: { username: "anna" },
      data: { elo: 40, ratedMatches: 2, ratedTurns: 30 },
    });
    const player = (username: string, elo: number, matches: number, turns: number, bot = false) =>
      prisma.user.create({
        data: {
          username,
          email: `${username}@example.test`,
          passwordHash: "x",
          isBot: bot,
          elo,
          ratedMatches: matches,
          ratedTurns: turns,
        },
      });
    await player("Bruno", 90, 5, 120);
    await player("carla_50%", 40, 1, 12);
    await player("dario", 0, 0, 0);
    await player("bot-1", 500, 9, 300, true);
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const ranking = async (query = "") =>
    (await app.inject({ url: `/api/leaderboard${query}`, headers: { cookie } })).json<Page>();

  it("is for who is signed in", async () => {
    expect((await app.inject({ url: "/api/leaderboard" })).statusCode).toBe(401);
  });

  it("lists who has finished a match, the best first, level players in the same place", async () => {
    const page = await ranking();
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 20 });
    expect(page.players).toEqual([
      { rank: 1, username: "Bruno", matches: 5, elo: 90, turns: 120 },
      { rank: 2, username: "anna", matches: 2, elo: 40, turns: 30 },
      { rank: 2, username: "carla_50%", matches: 1, elo: 40, turns: 12 },
    ]);
  });

  it("sorts by any column, searches by name and filters by matches played", async () => {
    const names = async (query: string) => (await ranking(query)).players.map((p) => p.username);
    expect(await names("?sort=turns&order=asc")).toEqual(["carla_50%", "anna", "Bruno"]);
    expect(await names("?sort=username&order=desc")).toEqual(["carla_50%", "Bruno", "anna"]);
    expect(await names("?sort=matches&order=desc")).toEqual(["Bruno", "anna", "carla_50%"]);
    expect(await names("?search=AN")).toEqual(["anna"]);
    // Written as it is: the percent sign is part of the name, not "anything".
    expect(await names("?search=50%25")).toEqual(["carla_50%"]);
    expect(await names("?search=%25")).toEqual(["carla_50%"]);
    expect(await names("?minMatches=2")).toEqual(["Bruno", "anna"]);
    // The place is the one in the whole ranking, whatever is searched.
    expect((await ranking("?search=carla")).players[0]?.rank).toBe(2);
  });

  it("is read a page at a time", async () => {
    const second = await ranking("?pageSize=2&page=2");
    expect(second).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(second.players.map((p) => p.username)).toEqual(["carla_50%"]);
    expect(await ranking("?pageSize=2&page=5")).toMatchObject({ total: 3, players: [] });
  });
});
