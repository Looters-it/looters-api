import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { phaseOfRoute, setPhase } from "./phase.js";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { EMPIRE_COLORS } from "../src/rules/catalogue.js";

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

interface State {
  match: { status: string; winnerEmpireId: string | null };
  me: { status: string; capitalMoveInTurns: number } | null;
  empires: {
    id: string;
    name: string;
    status: string;
    capitalTerritoryId: string | null;
    resources?: number;
  }[];
  territories: { id: string; name: string; alert: boolean; resources: number | null }[];
}

describe.skipIf(!url)("capital, fall and end of the match", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  let matchId: string;
  let unit: number[];
  const cookies: Record<string, string> = {};

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
    for (const name of ["anna", "bruno"]) {
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
    for (const [index, [user, start]] of (
      [
        ["anna", 0],
        ["bruno", 3],
      ] as const
    ).entries()) {
      await as(user, "POST", `/api/matches/${matchId}/join`, {
        geoUnitId: unit[start],
        empire: { name: user, color: EMPIRE_COLORS[index], emblem: "torre", motto: null },
      });
    }
    // Anna also holds Comune 1.
    const anna = await prisma.empire.findFirstOrThrow({ where: { matchId, name: "anna" } });
    await prisma.territory.update({
      where: { id: (await territoryOf(1)).id },
      data: { ownerEmpireId: anna.id },
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

  async function as(
    user: string | null,
    method: InjectOptions["method"],
    route: string,
    payload?: InjectOptions["payload"],
  ) {
    // Each action in the part of the turn it belongs to: see phase.ts.
    const phase = phaseOfRoute(method, route);
    if (phase) await setPhase(prisma, matchId, phase);
    return app.inject({
      method,
      url: route,
      payload,
      headers: user ? { cookie: cookies[user] ?? "" } : {},
    });
  }
  const territoryOf = async (index: number) =>
    (
      await prisma.territoryUnit.findUniqueOrThrow({
        where: { matchId_geoUnitId: { matchId, geoUnitId: unit[index] ?? 0 } },
        include: { territory: true },
      })
    ).territory;
  const state = async (user: string | null) =>
    (await as(user, "GET", `/api/matches/${matchId}/state`)).json<State>();
  const move = async (user: string, index: number, turn = 5) =>
    as(user, "POST", `/api/matches/${matchId}/capital`, {
      territoryId: (await territoryOf(index)).id,
      turn,
    });
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error?: { code: string } }).error?.code;

  describe("moving the capital", () => {
    it("moves it to another own territory and records the move", async () => {
      expect((await state("anna")).me?.capitalMoveInTurns).toBe(0);
      const response = await move("anna", 1);
      expect(response.statusCode, response.body).toBe(200);

      const after = response.json<State>();
      const destination = await territoryOf(1);
      expect(after.empires.find((e) => e.name === "anna")?.capitalTerritoryId).toBe(destination.id);
      // The capital is always visible to every empire.
      expect(
        (await state("bruno")).empires.find((e) => e.name === "anna")?.capitalTerritoryId,
      ).toBe(destination.id);
      const event = await prisma.gameEvent.findFirstOrThrow({ where: { type: "CAPITAL_MOVED" } });
      expect(event.data).toEqual({ empireName: "anna", territoryName: "Comune 1" });
    });

    it("allows one move every three turns", async () => {
      await move("anna", 1);
      expect((await state("anna")).me?.capitalMoveInTurns).toBe(3);
      expect(errorCode(await move("anna", 0))).toBe("CAPITAL_MOVED_RECENTLY");

      await prisma.match.update({ where: { id: matchId }, data: { currentTurn: 7 } });
      expect((await state("anna")).me?.capitalMoveInTurns).toBe(1);
      expect(errorCode(await move("anna", 0, 7))).toBe("CAPITAL_MOVED_RECENTLY");

      await prisma.match.update({ where: { id: matchId }, data: { currentTurn: 8 } });
      expect((await move("anna", 0, 8)).statusCode).toBe(200);
    });

    it("refuses territories of others, the current capital and a capital in a battle", async () => {
      expect(errorCode(await move("anna", 3))).toBe("NOT_YOUR_TERRITORY");
      expect(errorCode(await move("anna", 2))).toBe("NOT_YOUR_TERRITORY"); // free
      expect(errorCode(await move("anna", 0))).toBe("ALREADY_CAPITAL");

      const capital = await territoryOf(0);
      const battle = await prisma.battle.create({
        data: {
          matchId,
          turn: 5,
          attackerEmpireId: "x",
          defenderEmpireId: "y",
          targetTerritoryId: capital.id,
          attackPct: 50,
          attackCost: 1,
          attackForce: 1,
        },
      });
      // The capital cannot slip away from an attack.
      await prisma.battleLock.create({ data: { territoryId: capital.id, battleId: battle.id } });
      expect(errorCode(await move("anna", 1))).toBe("TERRITORY_IN_BATTLE");
    });
  });

  it("turns the player of a fallen empire into a spectator who cannot act", async () => {
    const bruno = await prisma.empire.findFirstOrThrow({ where: { matchId, name: "bruno" } });
    await prisma.empire.update({
      where: { id: bruno.id },
      data: { status: "FALLEN", fallenTurn: 5, capitalTerritoryId: null },
    });
    const freed = await territoryOf(3);
    await prisma.territory.update({ where: { id: freed.id }, data: { ownerEmpireId: null } });

    const seen = await state("bruno");
    expect(seen.me).toMatchObject({ status: "FALLEN" });
    // The freed territory is gone from the state: its resources stay hidden, even from its old owner.
    expect(seen.territories.find((t) => t.id === freed.id)).toBeUndefined();
    const card = await as("bruno", "GET", `/api/matches/${matchId}/units/${unit[3]}`);
    expect(card.json<{ territory: { resources: unknown }; annex: unknown }>()).toMatchObject({
      territory: { resources: null },
      annex: null,
    });

    expect(errorCode(await move("bruno", 3))).toBe("EMPIRE_FALLEN");
    const annex = await as("bruno", "POST", `/api/matches/${matchId}/annex`, {
      geoUnitId: unit[2],
      payFromTerritoryId: freed.id,
      turn: 5,
    });
    expect(errorCode(annex)).toBe("EMPIRE_FALLEN");
    // A spectator is not counted among the players still in the match.
    expect(((await state(null)) as unknown as { online: { total: number } }).online.total).toBe(1);
  });

  it("shows accumulation alerts to everyone, without any amount", async () => {
    const capital = await territoryOf(0);
    await prisma.territory.update({ where: { id: capital.id }, data: { alert: true } });
    for (const viewer of ["bruno", null]) {
      const seen = (await state(viewer)).territories.find((t) => t.id === capital.id);
      expect(seen).toMatchObject({ alert: true, resources: null });
    }
  });

  it("reveals the winner and everyone's resources only when the match is over", async () => {
    const running = await state("bruno");
    expect(running.empires.every((empire) => !("resources" in empire))).toBe(true);

    const anna = await prisma.empire.findFirstOrThrow({ where: { matchId, name: "anna" } });
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "FINISHED", finishedAt: new Date(), winnerEmpireId: anna.id },
    });
    const finished = await state(null);
    expect(finished.match).toMatchObject({ status: "FINISHED", winnerEmpireId: anna.id });
    const expected = (await territoryOf(0)).resources + (await territoryOf(1)).resources;
    expect(finished.empires.find((e) => e.id === anna.id)?.resources).toBe(expected);
    // Nothing can be done in a finished match.
    expect(errorCode(await move("anna", 1))).toBe("MATCH_NOT_RUNNING");
  });
});
