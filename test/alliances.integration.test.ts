import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { EMPIRE_COLORS } from "../src/rules/catalogue.js";

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

interface State {
  me: { empireId: string } | null;
  empires: { id: string; name: string }[];
  territories: { id: string; name: string; ownerEmpireId: string; resources: number | null }[];
  alliances: { id: string; members: { empireId: string; leavesAtTurn: number | null }[] }[];
  invites: { id: string; fromEmpireId: string; toEmpireId: string }[];
}

describe.skipIf(!url)("alliances", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  let matchId: string;
  /** Four municipalities in a row, one per player: anna, bruno, carla, dario. */
  let unit: number[];
  const cookies: Record<string, string> = {};
  const empire: Record<string, string> = {};
  const players = ["anna", "bruno", "carla", "dario"];

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
    for (let i = 0; i < 4; i++) {
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
    for (const name of players) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: name, email: `${name}@example.test`, password: "password-123" },
      });
      cookies[name] = `sid=${response.cookies.find((c) => c.name === "sid")?.value ?? ""}`;
    }
    const created = await as("anna", "POST", "/api/matches", {
      name: "Partita",
      areaIds: [area.id],
      startAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    matchId = created.json<{ id: string }>().id;
    await as("anna", "POST", `/api/matches/${matchId}/open`);
    for (const [index, user] of players.entries()) {
      const joined = await as(user, "POST", `/api/matches/${matchId}/join`, {
        geoUnitId: unit[index],
        empire: { name: user, color: EMPIRE_COLORS[index], emblem: "torre", motto: null },
      });
      empire[user] = joined.json<State>().me?.empireId ?? "";
    }
    await prisma.territory.updateMany({
      where: { matchId, ownerEmpireId: { not: null } },
      data: { resources: 100, protectedUntilTurn: null },
    });
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "RUNNING", currentTurn: 5, turnEndsAt: new Date(Date.now() + 3_600_000) },
    });
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  function as(
    user: string | null,
    method: InjectOptions["method"],
    route: string,
    payload?: InjectOptions["payload"],
  ) {
    return app.inject({
      method,
      url: route,
      payload,
      headers: user ? { cookie: cookies[user] ?? "" } : {},
    });
  }
  const state = async (user: string | null) =>
    (await as(user, "GET", `/api/matches/${matchId}/state`)).json<State>();
  const invite = (from: string, to: string) =>
    as(from, "POST", `/api/matches/${matchId}/alliances/invites`, { toEmpireId: empire[to] });
  const answer = async (user: string, action: string, from?: string) => {
    const pending = (await state(user)).invites.find(
      (i) => !from || i.fromEmpireId === empire[from],
    );
    return as(user, "POST", `/api/matches/${matchId}/alliances/invites/${pending?.id}/${action}`);
  };
  async function ally(a: string, b: string) {
    expect((await invite(a, b)).statusCode).toBe(201);
    const accepted = await answer(b, "accept", a);
    expect(accepted.statusCode, accepted.body).toBe(200);
  }
  const territoryOf = async (index: number) =>
    (
      await prisma.territoryUnit.findUniqueOrThrow({
        where: { matchId_geoUnitId: { matchId, geoUnitId: unit[index] ?? 0 } },
        include: { territory: true },
      })
    ).territory;
  const attack = async (user: string, target: number, from: number) =>
    as(user, "POST", `/api/matches/${matchId}/attacks`, {
      targetGeoUnitId: unit[target],
      fromTerritoryIds: [(await territoryOf(from)).id],
      turn: 5,
    });
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error?: { code: string } }).error?.code;

  describe("forming an alliance", () => {
    it("is proposed by one empire and exists once the other accepts", async () => {
      expect((await invite("anna", "bruno")).statusCode).toBe(201);
      // Nothing exists yet; both see the pending proposal, nobody else does.
      expect((await state("anna")).alliances).toEqual([]);
      expect((await state("anna")).invites).toHaveLength(1);
      expect((await state("bruno")).invites).toMatchObject([
        { fromEmpireId: empire.anna, toEmpireId: empire.bruno },
      ]);
      expect((await state("carla")).invites).toEqual([]);

      expect((await answer("bruno", "accept")).statusCode).toBe(200);
      // Alliances are public: everyone sees who is allied with whom.
      for (const viewer of ["carla", null]) {
        const seen = await state(viewer);
        expect(seen.alliances).toHaveLength(1);
        expect(seen.alliances[0]?.members.map((m) => m.empireId).sort()).toEqual(
          [empire.anna, empire.bruno].sort(),
        );
      }
      const event = await prisma.gameEvent.findFirstOrThrow({ where: { type: "ALLIANCE_FORMED" } });
      expect(event.data).toEqual({ empireName: "anna", otherName: "bruno" });
    });

    it("can be declined, or withdrawn by who proposed it", async () => {
      await invite("anna", "bruno");
      expect((await answer("bruno", "decline")).statusCode).toBe(200);
      expect((await state("anna")).invites).toEqual([]);

      await invite("anna", "bruno");
      // Only the invited empire can accept it.
      const pending = (await state("anna")).invites[0];
      const route = `/api/matches/${matchId}/alliances/invites/${pending?.id}`;
      expect((await as("anna", "POST", `${route}/accept`)).statusCode).toBe(404);
      expect((await as("carla", "POST", `${route}/accept`)).statusCode).toBe(404);
      expect((await as("anna", "POST", `${route}/withdraw`)).statusCode).toBe(200);
      expect(await prisma.alliance.count()).toBe(0);
    });

    it("admits a third member and stops at the maximum of three", async () => {
      await ally("anna", "bruno");
      await ally("bruno", "carla");
      expect((await state(null)).alliances[0]?.members).toHaveLength(3);
      const joined = await prisma.gameEvent.findFirstOrThrow({
        where: { type: "ALLIANCE_JOINED" },
      });
      expect(joined.data).toEqual({ empireName: "carla", otherName: "bruno" });

      expect(errorCode(await invite("anna", "dario"))).toBe("ALLIANCE_FULL");
    });

    it("keeps an empire in one alliance only", async () => {
      await ally("anna", "bruno");
      // Carla cannot pull Bruno into another alliance, nor propose twice the same thing.
      expect(errorCode(await invite("carla", "bruno"))).toBe("TARGET_IN_ALLIANCE");
      await invite("carla", "dario");
      expect(errorCode(await invite("carla", "dario"))).toBe("ALREADY_INVITED");
      expect((await invite("anna", "anna")).statusCode).toBe(404);
      expect(
        (
          await as(null, "POST", `/api/matches/${matchId}/alliances/invites`, {
            toEmpireId: empire.bruno,
          })
        ).statusCode,
      ).toBe(401);
    });

    it("drops the other pending proposals of two empires that ally", async () => {
      await invite("carla", "bruno");
      await invite("anna", "bruno");
      await answer("bruno", "accept", "anna");
      expect((await state("carla")).invites).toEqual([]);
      expect((await state("bruno")).invites).toEqual([]);
    });

    it("refuses an alliance between two empires that are fighting", async () => {
      await invite("anna", "bruno");
      expect((await attack("anna", 1, 0)).statusCode).toBe(201);
      expect(errorCode(await answer("bruno", "accept"))).toBe("ALLIANCE_AT_WAR");
    });
  });

  it("stops allies from attacking each other", async () => {
    await ally("anna", "bruno");
    expect(errorCode(await attack("anna", 1, 0))).toBe("TARGET_IS_ALLY");
    expect(errorCode(await attack("bruno", 0, 1))).toBe("TARGET_IS_ALLY");
    // The card of an ally's municipality offers no attack.
    const card = await as("anna", "GET", `/api/matches/${matchId}/units/${unit[1]}`);
    expect(card.json<{ attack: unknown }>().attack).toBeNull();
    // Anyone else can still be attacked.
    expect((await attack("bruno", 2, 1)).statusCode).toBe(201);
  });

  describe("leaving", () => {
    it("takes effect at the end of the following turn: until then the attack ban holds", async () => {
      await ally("anna", "bruno");
      const response = await as("anna", "POST", `/api/matches/${matchId}/alliances/leave`);
      expect(response.statusCode, response.body).toBe(200);

      // Announced in turn 5 with one turn of notice: effective when turn 6 closes.
      const member = (await state(null)).alliances[0]?.members.find(
        (m) => m.empireId === empire.anna,
      );
      expect(member?.leavesAtTurn).toBe(6);
      const event = await prisma.gameEvent.findFirstOrThrow({ where: { type: "ALLIANCE_LEFT" } });
      expect(event.data).toEqual({ empireName: "anna" });

      // No instant betrayal.
      expect(errorCode(await attack("anna", 1, 0))).toBe("TARGET_IS_ALLY");
      expect(errorCode(await attack("bruno", 0, 1))).toBe("TARGET_IS_ALLY");
      expect(errorCode(await as("anna", "POST", `/api/matches/${matchId}/alliances/leave`))).toBe(
        "LEAVING_ALLIANCE",
      );
      expect(errorCode(await invite("anna", "carla"))).toBe("LEAVING_ALLIANCE");
      expect(errorCode(await as("carla", "POST", `/api/matches/${matchId}/alliances/leave`))).toBe(
        "NOT_IN_ALLIANCE",
      );
    });

    it("frees the attack once jobs has made the exit effective", async () => {
      await ally("anna", "bruno");
      await as("anna", "POST", `/api/matches/${matchId}/alliances/leave`);
      // What jobs does when turn 6 closes.
      await prisma.allianceMember.deleteMany();
      await prisma.match.update({ where: { id: matchId }, data: { currentTurn: 7 } });
      const response = await as("anna", "POST", `/api/matches/${matchId}/attacks`, {
        targetGeoUnitId: unit[1],
        fromTerritoryIds: [(await territoryOf(0)).id],
        turn: 7,
      });
      expect(response.statusCode).toBe(201);
    });
  });

  describe("shared visibility", () => {
    const resourcesOf = async (viewer: string | null, owner: string) =>
      (await state(viewer)).territories.find((t) => t.ownerEmpireId === empire[owner])?.resources;

    it("shows allies each other's resources, and nobody else's", async () => {
      expect(await resourcesOf("anna", "bruno")).toBeNull();
      await ally("anna", "bruno");

      expect(await resourcesOf("anna", "bruno")).toBe(100);
      expect(await resourcesOf("bruno", "anna")).toBe(100);
      // Not allies: still hidden, in both directions.
      expect(await resourcesOf("anna", "carla")).toBeNull();
      expect(await resourcesOf("carla", "anna")).toBeNull();
      expect(await resourcesOf(null, "anna")).toBeNull();
      // The card of an ally's municipality shows the amount too.
      const card = await as("anna", "GET", `/api/matches/${matchId}/units/${unit[1]}`);
      expect(card.json<{ territory: { resources: number } }>().territory.resources).toBe(100);
      const stranger = await as("carla", "GET", `/api/matches/${matchId}/units/${unit[1]}`);
      expect(stranger.json<{ territory: { resources: unknown } }>().territory.resources).toBeNull();
    });

    it("is revoked when the exit takes effect, not before", async () => {
      await ally("anna", "bruno");
      await as("anna", "POST", `/api/matches/${matchId}/alliances/leave`);
      // Still an ally during the notice.
      expect(await resourcesOf("anna", "bruno")).toBe(100);

      await prisma.allianceMember.deleteMany(); // jobs, at the close of the notice turn
      expect(await resourcesOf("anna", "bruno")).toBeNull();
      expect(await resourcesOf("bruno", "anna")).toBeNull();
    });
  });

  describe("transfers", () => {
    const transfer = async (user: string, from: number, to: number, amount: number, turn = 5) =>
      as(user, "POST", `/api/matches/${matchId}/alliances/transfer`, {
        fromTerritoryId: (await territoryOf(from)).id,
        toTerritoryId: (await territoryOf(to)).id,
        amount,
        turn,
      });

    it("moves resources from an own territory to an ally's, at no cost", async () => {
      await ally("anna", "bruno");
      const response = await transfer("anna", 0, 1, 60);
      expect(response.statusCode, response.body).toBe(200);
      expect((await territoryOf(0)).resources).toBe(40);
      expect((await territoryOf(1)).resources).toBe(160);
      // Territories need not be adjacent: allies in an alliance of three can reach each other.
      await ally("bruno", "carla");
      expect((await transfer("anna", 0, 2, 40)).statusCode).toBe(200);
      expect((await territoryOf(0)).resources).toBe(0);
    });

    it("refuses non-allies, other people's territories and more than there is", async () => {
      await ally("anna", "bruno");
      expect(errorCode(await transfer("anna", 0, 2, 10))).toBe("NOT_AN_ALLY");
      expect(errorCode(await transfer("anna", 1, 0, 10))).toBe("NOT_YOUR_TERRITORY");
      expect(errorCode(await transfer("anna", 0, 1, 101))).toBe("NOT_ENOUGH_RESOURCES");
      expect((await transfer("anna", 0, 1, 0)).statusCode).toBe(400);
      expect(errorCode(await transfer("anna", 0, 1, 10, 4))).toBe("TURN_CHANGED");
      expect((await territoryOf(1)).resources).toBe(100);
    });

    it("cannot rescue a territory already under attack: help is preventive only", async () => {
      await ally("anna", "bruno");
      // Carla attacks Bruno's territory.
      expect((await attack("carla", 1, 2)).statusCode).toBe(201);
      expect(errorCode(await transfer("anna", 0, 1, 50))).toBe("TERRITORY_IN_BATTLE");
      // Nor can the attacked territory send its resources away to an ally.
      expect(errorCode(await transfer("bruno", 1, 0, 50))).toBe("TERRITORY_IN_BATTLE");
    });
  });

  describe("alliance chat", () => {
    const chat = (user: string | null) => as(user, "GET", `/api/matches/${matchId}/alliances/chat`);
    const say = (user: string, text: string) =>
      as(user, "POST", `/api/matches/${matchId}/alliances/chat`, { text });

    it("is private to the members of the alliance", async () => {
      await ally("anna", "bruno");
      expect((await say("anna", "Attacchiamo a est?")).statusCode).toBe(201);
      expect((await say("bruno", "Al prossimo turno.")).statusCode).toBe(201);

      const seen = (await chat("bruno")).json<{ text: string; empireId: string }[]>();
      expect(seen.map((message) => message.text)).toEqual([
        "Al prossimo turno.",
        "Attacchiamo a est?",
      ]);
      expect(seen[1]?.empireId).toBe(empire.anna);

      expect(errorCode(await chat("carla"))).toBe("NOT_IN_ALLIANCE");
      expect(errorCode(await say("carla", "Ciao"))).toBe("NOT_IN_ALLIANCE");
      expect((await chat(null)).statusCode).toBe(401);
      // The chat never reaches the public board.
      const board = await as(null, "GET", `/api/matches/${matchId}/board`);
      expect(board.body).not.toContain("Attacchiamo");
    });

    it("is not readable by another alliance", async () => {
      await ally("anna", "bruno");
      await ally("carla", "dario");
      await say("anna", "Segreto");
      expect((await chat("carla")).json()).toEqual([]);
    });
  });
});
