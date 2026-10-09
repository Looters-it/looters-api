import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { BotRunner } from "../src/modules/bots/runner.js";
import type { BotService } from "../src/modules/bots/service.js";
import { EMPIRE_COLORS } from "../src/rules/catalogue.js";
import { DEFAULT_MATCH_RULES } from "../src/rules/config.js";

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

interface State {
  me: { empireId: string; annexLeft: number } | null;
  empires: { id: string; name: string; username: string; isBot: boolean; units: number }[];
  territories: { id: string; ownerEmpireId: string; geoUnitIds: number[] }[];
  battles: { id: string; status: string; response: string | null }[];
}

describe.skipIf(!url)("bots", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  let matchId: string;
  /** Six municipalities in a row; Anna, the only player, starts on the first. */
  let unit: number[];
  let cookie = "";

  beforeEach(async () => {
    await prisma.job.deleteMany();
    await prisma.match.deleteMany();
    await prisma.geoArea.deleteMany();
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
    const area = await prisma.geoArea.create({ data: { name: "Provincia" } });
    const upload = await prisma.geoUpload.create({
      data: { areaId: area.id, filename: "f", format: "GEOJSON", storagePath: "f" },
    });
    unit = [];
    for (let i = 0; i < 6; i++) {
      const lon = 9 + i * 0.1;
      const wkt = `POLYGON((${lon} 45,${lon + 0.1} 45,${lon + 0.1} 45.1,${lon} 45.1,${lon} 45))`;
      const rows = await prisma.$queryRaw<{ id: number }[]>`
        INSERT INTO "GeoUnit" ("areaId", "uploadId", name, "centroidLon", "centroidLat", "areaKm2", geom, "geomSimple")
        VALUES (${area.id}, ${upload.id}, ${`Comune ${i}`}, ${lon + 0.05}, 45.05, 80,
          ST_Multi(ST_GeomFromText(${wkt}, 4326)), ST_Multi(ST_GeomFromText(${wkt}, 4326)))
        RETURNING id`;
      unit.push(rows[0]?.id ?? 0);
    }
    await prisma.geoAdjacency.createMany({
      data: unit.slice(1).map((id, i) => ({ aId: unit[i] ?? 0, bId: id })),
    });
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "anna", email: "anna@example.test", password: "password-123" },
    });
    cookie = `sid=${registered.cookies.find((c) => c.name === "sid")?.value ?? ""}`;
    const created = await as("POST", "/api/matches", {
      name: "Partita con i bot",
      areaIds: [area.id],
      startAt: new Date(Date.now() + 86_400_000).toISOString(),
      config: { botsEnabled: true, botsMax: 2, botSpawnChancePct: 100 },
    });
    matchId = created.json<{ id: string }>().id;
    await as("POST", `/api/matches/${matchId}/join`, {
      geoUnitId: unit[0],
      empire: { name: "Anna", color: EMPIRE_COLORS[0], emblem: "torre", motto: null },
    });
    await prisma.territory.updateMany({
      where: { matchId, ownerEmpireId: { not: null } },
      data: { resources: 500, protectedUntilTurn: null },
    });
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "ONGOING", currentTurn: 5, turnEndsAt: new Date(Date.now() + 3_600_000) },
    });
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  function as(method: InjectOptions["method"], route: string, payload?: InjectOptions["payload"]) {
    return app.inject({ method, url: route, payload, headers: { cookie } });
  }
  const state = async () => (await as("GET", `/api/matches/${matchId}/state`)).json<State>();
  const bots = async () => (await state()).empires.filter((empire) => empire.isBot);

  it("needs one player only: a match starts with a single empire by default", () => {
    expect(DEFAULT_MATCH_RULES.minPlayersToStart).toBe(1);
    expect(DEFAULT_MATCH_RULES.botsEnabled).toBe(false);
  });

  it("founds the bots a match has from its start all together, on its first turn", async () => {
    const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
    await prisma.match.update({
      where: { id: matchId },
      // No chance of a bot by luck: only those owed at the start.
      data: {
        currentTurn: 1,
        config: { ...(match.config as object), botsAtStart: 2, botSpawnChancePct: 0 },
      },
    });
    await app.bots.playTurn(matchId);
    expect(await bots()).toHaveLength(2);
    // Played again, the first turn owes no more.
    await app.bots.playTurn(matchId);
    expect(await bots()).toHaveLength(2);
  });

  it("founds bot empires on free municipalities as turns begin, up to the limit of the match", async () => {
    expect(await bots()).toEqual([]);
    await app.bots.playTurn(matchId);
    await app.bots.playTurn(matchId);
    await app.bots.playTurn(matchId);

    const founded = await bots();
    // Two at most in this match, each on a municipality that was free, marked as bots.
    expect(founded).toHaveLength(2);
    expect(new Set(founded.map((bot) => bot.name)).size).toBe(2);
    for (const bot of founded) {
      expect(bot.name).toMatch(/ di Comune \d/);
      expect(bot.username).toMatch(/^bot_/);
      expect(bot.units).toBeGreaterThanOrEqual(1);
    }
    // The first appears near the player: two municipalities away, not touching.
    const firstBot = await prisma.empire.findFirstOrThrow({
      where: { matchId, user: { isBot: true } },
      orderBy: { joinedAt: "asc" },
    });
    const capital = await prisma.territoryUnit.findFirstOrThrow({
      where: { territoryId: firstBot.capitalTerritoryId ?? "" },
    });
    expect(capital.geoUnitId).toBe(unit[2]);
    // The player is not one of them, and is told so.
    expect((await state()).empires.find((empire) => empire.name === "Anna")?.isBot).toBe(false);
    // Founding one is announced like any other empire.
    expect(await prisma.gameEvent.count({ where: { matchId, type: "EMPIRE_CREATED" } })).toBe(3);
  });

  it("never founds any where the match does not want them", async () => {
    await prisma.match.update({
      where: { id: matchId },
      data: { config: { ...DEFAULT_MATCH_RULES, botsEnabled: false, botSpawnChancePct: 100 } },
    });
    await app.bots.playTurn(matchId);
    expect(await prisma.user.count({ where: { isBot: true } })).toBe(0);

    // Nor in a match that is not being played.
    await prisma.match.update({
      where: { id: matchId },
      data: { config: { ...DEFAULT_MATCH_RULES, botsEnabled: true }, status: "FINISHED" },
    });
    await app.bots.playTurn(matchId);
    expect(await prisma.user.count({ where: { isBot: true } })).toBe(0);
  });

  it("plays like a player: a bot annexes free neighbours, within what a turn allows", async () => {
    const spawned = await app.bots.maybeSpawn(matchId, true);
    expect(spawned).not.toBeNull();
    const botId = spawned?.empireId ?? "";
    await prisma.territory.updateMany({
      where: { matchId, ownerEmpireId: botId },
      data: { resources: 500, protectedUntilTurn: null },
    });
    // No new bot this time: only the one there plays.
    await prisma.match.update({
      where: { id: matchId },
      data: { config: { ...DEFAULT_MATCH_RULES, botsEnabled: true, botsMax: 1 } },
    });
    const unitsOf = async () => (await bots())[0]?.units ?? 0;
    expect(await unitsOf()).toBe(1);

    await app.bots.playTurn(matchId);
    // One annexation per turn is the rule of the match, for a bot as for anyone.
    expect(await unitsOf()).toBe(1 + DEFAULT_MATCH_RULES.annexPerTurn);
    await app.bots.playTurn(matchId);
    expect(await unitsOf()).toBe(1 + DEFAULT_MATCH_RULES.annexPerTurn);

    // The next turn it grows again.
    await prisma.empire.updateMany({ where: { matchId }, data: { annexedThisTurn: 0 } });
    await prisma.match.update({ where: { id: matchId }, data: { currentTurn: 6 } });
    await app.bots.playTurn(matchId);
    expect(await unitsOf()).toBe(1 + 2 * DEFAULT_MATCH_RULES.annexPerTurn);
  });

  it("answers an attack on its own, and attacks through the same rules as a player", async () => {
    await prisma.match.update({
      where: { id: matchId },
      data: { config: { ...DEFAULT_MATCH_RULES, botsEnabled: true, botsMax: 1 } },
    });
    // Put the bot right next to Anna.
    const user = await prisma.user.create({
      data: { username: "bot_test", email: "bot@looters.invalid", passwordHash: "!", isBot: true },
    });
    const empire = await prisma.empire.create({
      data: {
        matchId,
        userId: user.id,
        name: "Bot di prova",
        color: EMPIRE_COLORS[1] ?? "",
        emblem: "luna",
      },
    });
    const next = await prisma.territoryUnit.findUniqueOrThrow({
      where: { matchId_geoUnitId: { matchId, geoUnitId: unit[1] ?? 0 } },
    });
    await prisma.territory.update({
      where: { id: next.territoryId },
      data: { ownerEmpireId: empire.id, resources: 300 },
    });
    await prisma.empire.update({
      where: { id: empire.id },
      data: { capitalTerritoryId: next.territoryId },
    });
    const mine = (await state()).territories.find((t) => t.geoUnitIds.includes(unit[0] ?? 0));

    const declared = await as("POST", `/api/matches/${matchId}/attacks`, {
      targetGeoUnitId: unit[1],
      fromTerritoryIds: [mine?.id],
      turn: 5,
    });
    expect(declared.statusCode, declared.body).toBe(201);
    expect((await prisma.battle.findFirstOrThrow({ where: { matchId } })).response).toBeNull();

    await app.bots.answerAttacks(matchId);
    // It is its capital: it never gives that up.
    expect((await prisma.battle.findFirstOrThrow({ where: { matchId } })).response).toBe("DEFEND");
    // Asked again, it has nothing left to answer.
    await app.bots.answerAttacks(matchId);
    expect(await prisma.battle.count({ where: { matchId } })).toBe(1);
  });

  it("cannot be logged in as, and is not counted among the users", async () => {
    await app.bots.maybeSpawn(matchId, true);
    const bot = await prisma.user.findFirstOrThrow({ where: { isBot: true } });
    for (const password of ["!", "", "password-123"]) {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: bot.username, password },
      });
      expect([400, 401]).toContain(login.statusCode);
    }
  });

  describe("when they act", () => {
    it("plays when a turn begins and answers when a battle is declared, one match at a time", async () => {
      const calls: string[] = [];
      const fake = {
        playTurn: (id: string) => {
          calls.push(`turn:${id}`);
          return Promise.resolve();
        },
        answerAttacks: (id: string) => {
          calls.push(`answer:${id}`);
          return Promise.resolve();
        },
      } as unknown as BotService;
      const runner = new BotRunner(fake, () => 5);
      runner.matchChanged("m1", "turn.closed");
      runner.matchChanged("m1", "turn.closed"); // said twice, done once
      runner.matchChanged("m1", "battles");
      runner.matchChanged("m2", "match.started");
      runner.matchChanged("m1", "territories"); // nothing for a bot to do
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(calls.sort()).toEqual(["answer:m1", "turn:m1", "turn:m2"]);

      runner.stop();
      runner.matchChanged("m1", "turn.closed");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toHaveLength(3);
    });
  });
});
