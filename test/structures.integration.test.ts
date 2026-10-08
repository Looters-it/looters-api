import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { EMPIRE_COLORS } from "../src/rules/catalogue.js";
import { DEFAULT_MATCH_RULES } from "../src/rules/config.js";
import {
  registerStructure,
  structureBlock,
  structureCatalogue,
  structureDefinition,
  turnsToResources,
  unregisterStructure,
} from "../src/rules/structures.js";

describe("structure catalogue", () => {
  const site = {
    isCapital: false,
    inBattle: false,
    resources: 1000,
    ownedByEmpire: 0,
    activeHere: false,
    cooldownUntilTurn: null,
    currentTurn: 10,
  };

  it("declares the two structures of the game with their costs and durations", () => {
    expect(structureCatalogue().map((definition) => definition.type)).toEqual([
      "BLOCK",
      "SECOND_CAPITAL",
    ]);
    const block = structureDefinition("BLOCK");
    const second = structureDefinition("SECOND_CAPITAL");
    // A fixed cost, and a cost in turns: 20 turns of an income of 70.
    expect(block?.cost(DEFAULT_MATCH_RULES, 70)).toBe(300);
    expect(second?.cost(DEFAULT_MATCH_RULES, 70)).toBe(1400);
    expect(block?.durationTurns(DEFAULT_MATCH_RULES)).toBe(5);
    expect(second?.durationTurns(DEFAULT_MATCH_RULES)).toBeNull();
    expect(turnsToResources(0.5, 75)).toBe(38); // rounded up
  });

  it("gives the first reason a structure cannot be built", () => {
    const defined = (type: string) => {
      const definition = structureDefinition(type);
      if (!definition) throw new Error(`${type} is not in the catalogue`);
      return definition;
    };
    const block = defined("BLOCK");
    const second = defined("SECOND_CAPITAL");
    expect(structureBlock(block, site, 300)).toBeNull();
    expect(structureBlock(block, { ...site, inBattle: true }, 300)).toBe("IN_BATTLE");
    expect(structureBlock(block, { ...site, activeHere: true }, 300)).toBe("ALREADY_HERE");
    expect(structureBlock(block, { ...site, resources: 299 }, 300)).toBe("NOT_ENOUGH_RESOURCES");
    // Cooldown lasts through the stored turn, and is over the turn after.
    expect(structureBlock(block, { ...site, cooldownUntilTurn: 10 }, 300)).toBe("COOLDOWN");
    expect(structureBlock(block, { ...site, cooldownUntilTurn: 9 }, 300)).toBeNull();
    expect(structureBlock(second, { ...site, isCapital: true }, 10)).toBe("ON_CAPITAL");
    expect(structureBlock(second, { ...site, ownedByEmpire: 1 }, 10)).toBe("ONE_PER_EMPIRE");
    // A block may stand on the capital.
    expect(structureBlock(block, { ...site, isCapital: true }, 300)).toBeNull();
  });
});

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

interface State {
  me: { turnValue: number };
  territories: {
    id: string;
    name: string;
    resources: number | null;
    isArea: boolean;
    geoUnitIds: number[];
  }[];
  structures: {
    id: string;
    type: string;
    territoryId: string;
    turnsLeft: number | null;
    effects: string[];
  }[];
  empires: { name: string; units: number; capitalTerritoryId: string }[];
}

describe.skipIf(!url)("structures and merged areas", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  let matchId: string;
  /** Six municipalities in a row: unit[i] borders unit[i + 1]. */
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
    await as("anna", "POST", `/api/matches/${matchId}/open`);
    for (const [index, [user, start]] of (
      [
        ["anna", 0],
        ["bruno", 5],
      ] as const
    ).entries()) {
      await as(user, "POST", `/api/matches/${matchId}/join`, {
        geoUnitId: unit[start],
        empire: { name: user, color: EMPIRE_COLORS[index], emblem: "torre", motto: null },
      });
    }
    // Anna holds 0 (capital), 1, 2 and 3; Bruno holds 5 and 4. Everyone is rich.
    for (const [index, owner] of [
      [0, "anna"],
      [1, "anna"],
      [2, "anna"],
      [3, "anna"],
      [4, "bruno"],
      [5, "bruno"],
    ] as const) {
      const empire = await prisma.empire.findFirstOrThrow({ where: { matchId, name: owner } });
      await prisma.territory.update({
        where: { id: (await territoryOf(index)).id },
        data: { ownerEmpireId: empire.id, resources: 2000, protectedUntilTurn: null },
      });
    }
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "RUNNING", currentTurn: 10, turnEndsAt: new Date(Date.now() + 3_600_000) },
    });
  });
  afterEach(async () => {
    unregisterStructure("WATCHTOWER");
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
  const territoryOf = async (index: number) =>
    (
      await prisma.territoryUnit.findUniqueOrThrow({
        where: { matchId_geoUnitId: { matchId, geoUnitId: unit[index] ?? 0 } },
        include: { territory: true },
      })
    ).territory;
  const idOf = async (index: number) => (await territoryOf(index)).id;
  const state = async (user: string | null) =>
    (await as(user, "GET", `/api/matches/${matchId}/state`)).json<State>();
  const build = async (user: string, type: string, index: number, turn = 10) =>
    as(user, "POST", `/api/matches/${matchId}/structures`, {
      type,
      territoryId: await idOf(index),
      turn,
    });
  const attack = async (user: string, target: number, from: number[]) =>
    as(user, "POST", `/api/matches/${matchId}/attacks`, {
      targetGeoUnitId: unit[target],
      fromTerritoryIds: await Promise.all(from.map(idOf)),
      turn: 10,
    });
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error?: { code: string } }).error?.code;

  describe("military block", () => {
    it("costs 300 from the territory, lasts five turns and is public", async () => {
      const response = await build("anna", "BLOCK", 3);
      expect(response.statusCode, response.body).toBe(201);
      expect((await territoryOf(3)).resources).toBe(1700);

      const structure = await prisma.structure.findFirstOrThrow();
      // Built in turn 10 for 5 turns: active through turn 14, then 5 turns of pause.
      expect(structure).toMatchObject({
        type: "BLOCK",
        builtTurn: 10,
        expiresTurn: 14,
        cooldownUntilTurn: 19,
        active: true,
      });
      for (const viewer of ["bruno", null]) {
        expect((await state(viewer)).structures).toMatchObject([
          {
            type: "BLOCK",
            territoryId: structure.territoryId,
            turnsLeft: 5,
            effects: ["NO_ATTACK_ON", "NO_ATTACK_FROM"],
          },
        ]);
      }
    });

    it("stops attacks on the territory and from it", async () => {
      await build("anna", "BLOCK", 3);
      expect(errorCode(await attack("bruno", 3, [4]))).toBe("TARGET_BLOCKED");
      expect(errorCode(await attack("anna", 4, [3]))).toBe("SOURCE_BLOCKED");
      const card = await as("bruno", "GET", `/api/matches/${matchId}/units/${unit[3]}`);
      expect(card.json<{ attack: { blocked: string } }>().attack.blocked).toBe("BLOCKED");
    });

    it("cannot be renewed in a row: a pause must pass after it ends", async () => {
      await build("anna", "BLOCK", 3);
      expect(errorCode(await build("anna", "BLOCK", 3))).toBe("STRUCTURE_ALREADY_HERE");

      // Turn 15: the block has expired (jobs does that at the close of turn 14).
      await prisma.structure.updateMany({ data: { active: false } });
      for (const turn of [15, 19]) {
        await prisma.match.update({ where: { id: matchId }, data: { currentTurn: turn } });
        expect(errorCode(await build("anna", "BLOCK", 3, turn))).toBe("STRUCTURE_COOLDOWN");
      }
      await prisma.match.update({ where: { id: matchId }, data: { currentTurn: 20 } });
      expect((await build("anna", "BLOCK", 3, 20)).statusCode).toBe(201);
      // Another territory was never in pause.
      expect((await build("anna", "BLOCK", 2, 20)).statusCode).toBe(201);
    });

    it("needs the resources, an own territory and no battle on it", async () => {
      await prisma.territory.update({ where: { id: await idOf(3) }, data: { resources: 299 } });
      expect(errorCode(await build("anna", "BLOCK", 3))).toBe("STRUCTURE_NOT_ENOUGH_RESOURCES");
      expect(errorCode(await build("anna", "BLOCK", 4))).toBe("NOT_YOUR_TERRITORY");
      expect(errorCode(await build("anna", "NO_SUCH", 2))).toBe("UNKNOWN_STRUCTURE");

      await attack("bruno", 3, [4]);
      // Too late to shield a territory already under attack.
      await prisma.territory.update({ where: { id: await idOf(3) }, data: { resources: 2000 } });
      expect(errorCode(await build("anna", "BLOCK", 3))).toBe("STRUCTURE_IN_BATTLE");
      expect(await prisma.structure.count()).toBe(0);
    });
  });

  describe("second capital", () => {
    it("costs twenty turns of income, once per empire, away from the capital", async () => {
      // Anna controls four municipalities: 50 + 10 x 4 = 90 per turn, so 1800.
      expect((await state("anna")).me.turnValue).toBe(90);
      expect(errorCode(await build("anna", "SECOND_CAPITAL", 0))).toBe("STRUCTURE_ON_CAPITAL");

      expect((await build("anna", "SECOND_CAPITAL", 2)).statusCode).toBe(201);
      expect((await territoryOf(2)).resources).toBe(200);
      expect((await state("bruno")).structures).toMatchObject([
        { type: "SECOND_CAPITAL", turnsLeft: null, effects: ["BACKUP_CAPITAL"] },
      ]);
      expect(errorCode(await build("anna", "SECOND_CAPITAL", 3))).toBe("STRUCTURE_ONE_PER_EMPIRE");
      const event = await prisma.gameEvent.findFirstOrThrow({ where: { type: "CAPITAL_BUILT" } });
      expect(event.data).toEqual({ empireName: "anna", territoryName: "Comune 2" });
    });

    it("moves at its own pace, independent of the main capital", async () => {
      await build("anna", "SECOND_CAPITAL", 2);
      const id = (await prisma.structure.findFirstOrThrow()).id;
      const move = async (index: number, turn = 10) =>
        as("anna", "POST", `/api/matches/${matchId}/structures/${id}/move`, {
          territoryId: await idOf(index),
          turn,
        });

      expect(errorCode(await move(0))).toBe("STRUCTURE_ON_CAPITAL");
      expect((await move(3)).statusCode).toBe(200);
      expect((await prisma.structure.findFirstOrThrow()).territoryId).toBe(await idOf(3));
      expect(errorCode(await move(1))).toBe("STRUCTURE_MOVED_RECENTLY");
      // The main capital has its own interval and can still move.
      const capital = await as("anna", "POST", `/api/matches/${matchId}/capital`, {
        territoryId: await idOf(1),
        turn: 10,
      });
      expect(capital.statusCode).toBe(200);

      await prisma.match.update({ where: { id: matchId }, data: { currentTurn: 13 } });
      expect((await move(2, 13)).statusCode).toBe(200);
    });
  });

  it("accepts a new structure with no change to the schema or to the turn logic", async () => {
    // A structure invented here: a tower that lasts two turns and stops attacks on its territory.
    registerStructure({
      type: "WATCHTOWER",
      cost: (_rules, turnValue) => turnsToResources(2, turnValue),
      durationTurns: () => 2,
      effects: ["NO_ATTACK_ON"],
    });

    const catalogue = (
      await as("anna", "GET", `/api/matches/${matchId}/structures/catalogue`)
    ).json<
      {
        type: string;
        cost: number;
        durationTurns: number | null;
        sites: { name: string; blocked: string | null }[];
      }[]
    >();
    const tower = catalogue.find((entry) => entry.type === "WATCHTOWER");
    expect(tower).toMatchObject({ cost: 180, durationTurns: 2 });
    expect(tower?.sites).toHaveLength(4);

    expect((await build("anna", "WATCHTOWER", 3)).statusCode).toBe(201);
    expect(await prisma.structure.findFirstOrThrow()).toMatchObject({
      type: "WATCHTOWER",
      expiresTurn: 11,
    });
    // Its effect works at once, through the same check every structure goes through.
    expect(errorCode(await attack("bruno", 3, [4]))).toBe("TARGET_BLOCKED");
    // Unlike a military block, the tower does not stop its own territory from attacking.
    expect((await attack("anna", 4, [3])).statusCode).toBe(201);
  });

  it("shows a player where each structure can be built and why not", async () => {
    const catalogue = (
      await as("anna", "GET", `/api/matches/${matchId}/structures/catalogue`)
    ).json<{ type: string; cost: number; sites: { name: string; blocked: string | null }[] }[]>();
    const second = catalogue.find((entry) => entry.type === "SECOND_CAPITAL");
    expect(second?.cost).toBe(1800);
    expect(second?.sites.find((site) => site.name === "Comune 0")?.blocked).toBe("ON_CAPITAL");
    expect(second?.sites.find((site) => site.name === "Comune 2")?.blocked).toBeNull();
    expect(
      (await as("bruno", "GET", `/api/matches/${matchId}/structures/catalogue`)).json<
        { sites: unknown[] }[]
      >()[0]?.sites,
    ).toHaveLength(2);
    expect((await as(null, "GET", `/api/matches/${matchId}/structures/catalogue`)).statusCode).toBe(
      401,
    );
  });

  describe("merging territories", () => {
    const merge = async (user: string, indexes: number[], name = "Marca Orientale") =>
      as(user, "POST", `/api/matches/${matchId}/merge`, {
        territoryIds: await Promise.all(indexes.map(idOf)),
        name,
        turn: 10,
      });
    const preview = async (indexes: number[]) =>
      (
        await as("anna", "POST", `/api/matches/${matchId}/merge/preview`, {
          territoryIds: await Promise.all(indexes.map(idOf)),
        })
      ).json<{
        perTerritory: number;
        cost: number;
        problem: string | null;
        maxUnits: number;
        blocksLost: number;
      }>();

    it("joins contiguous territories into one area that sums their resources", async () => {
      // Half a turn of income (45) for each territory included.
      expect(await preview([1, 2, 3])).toMatchObject({
        perTerritory: 45,
        cost: 135,
        problem: null,
        maxUnits: 5,
      });

      const response = await merge("anna", [1, 2, 3]);
      expect(response.statusCode, response.body).toBe(201);
      const after = response.json<State>();

      const area = after.territories.find((territory) => territory.isArea);
      expect(area).toMatchObject({ name: "Marca Orientale", resources: 6000 - 135 });
      expect([...(area?.geoUnitIds ?? [])].sort()).toEqual([unit[1], unit[2], unit[3]].sort());
      // Three territories became one, but the empire still controls four municipalities,
      // and earns on four.
      expect(after.territories.filter((t) => t.resources !== null)).toHaveLength(2);
      expect(after.empires.find((e) => e.name === "anna")?.units).toBe(4);
      expect(after.me.turnValue).toBe(90);
      const event = await prisma.gameEvent.findFirstOrThrow({ where: { type: "AREA_CREATED" } });
      expect(event.data).toEqual({ empireName: "anna", territoryName: "Marca Orientale" });
    });

    it("borders whatever any of its municipalities bordered, and fights as one territory", async () => {
      await merge("anna", [1, 2, 3]);
      const area = (await state("anna")).territories.find((territory) => territory.isArea);

      // Seen from any of its municipalities, the area borders Comune 0 and Comune 4.
      const card = (await as("anna", "GET", `/api/matches/${matchId}/units/${unit[2]}`)).json<{
        territory: { id: string };
        neighbours: { name: string }[];
      }>();
      expect(card.territory.id).toBe(area?.id);
      expect(card.neighbours.map((n) => n.name)).toEqual(["Comune 0", "Comune 4"]);

      // It attacks as a single territory: one source, no progressive cost, all its resources as strength.
      const response = await attack("anna", 4, [3]);
      expect(response.statusCode, response.body).toBe(201);
      expect(await prisma.battle.findFirstOrThrow()).toMatchObject({
        attackPct: 50,
        attackForce: 5865,
      });
    });

    it("keeps the capital where it is when the capital is part of the area", async () => {
      await merge("anna", [0, 1]);
      const after = await state("anna");
      const area = after.territories.find((territory) => territory.isArea);
      expect(after.empires.find((e) => e.name === "anna")?.capitalTerritoryId).toBe(area?.id);
    });

    it("explains why a merge is not possible", async () => {
      expect((await preview([1])).problem).toBe("TOO_FEW");
      expect((await preview([1, 3])).problem).toBe("NOT_CONTIGUOUS");
      expect((await preview([3, 4])).problem).toBe("NOT_YOURS");
      await prisma.territory.updateMany({ where: { matchId }, data: { resources: 10 } });
      expect((await preview([1, 2])).problem).toBe("NOT_ENOUGH_RESOURCES");
      await prisma.territory.updateMany({ where: { matchId }, data: { resources: 2000 } });

      // At most five municipalities in an area: a second merge cannot go past the limit.
      await prisma.match.update({
        where: { id: matchId },
        data: { config: { ...DEFAULT_MATCH_RULES, mergeMaxUnits: 3 } },
      });
      expect((await preview([0, 1, 2, 3])).problem).toBe("TOO_MANY");
      expect(errorCode(await merge("anna", [0, 1, 2, 3]))).toBe("MERGE_TOO_MANY");

      await attack("bruno", 3, [4]);
      expect((await preview([2, 3])).problem).toBe("IN_BATTLE");
      expect(await prisma.territory.count({ where: { matchId, isArea: true } })).toBe(0);
    });

    it("renames an area, which only its owner can do", async () => {
      await merge("anna", [1, 2]);
      const area = (await state("anna")).territories.find((territory) => territory.isArea);
      const route = `/api/matches/${matchId}/territories/${area?.id}`;

      expect((await as("bruno", "PATCH", route, { name: "Mia" })).statusCode).toBe(404);
      const renamed = await as("anna", "PATCH", route, { name: "Contado di Levante" });
      expect(renamed.json<State>().territories.find((t) => t.isArea)?.name).toBe(
        "Contado di Levante",
      );
      // A plain territory keeps the name of its municipality.
      const plain = await as(
        "anna",
        "PATCH",
        `/api/matches/${matchId}/territories/${await idOf(3)}`,
        { name: "No" },
      );
      expect(plain.statusCode).toBe(404);
    });

    it("serves the outline of each area, with its name, for the map", async () => {
      await merge("anna", [1, 2, 3]);
      const areas = (await as(null, "GET", `/api/matches/${matchId}/areas`)).json<{
        features: { geometry: { type: string }; properties: { name: string; lon: number } }[];
      }>();
      expect(areas.features).toHaveLength(1);
      // One feature for the whole area, whatever the shape of its municipalities.
      expect(areas.features[0]?.properties.name).toBe("Marca Orientale");
      expect(["Polygon", "MultiPolygon"]).toContain(areas.features[0]?.geometry.type);
      expect(areas.features[0]?.properties.lon).toBeGreaterThan(9.1);
    });

    it("cancels a block on a merged municipality, after warning, and keeps other structures", async () => {
      await build("anna", "BLOCK", 2);
      expect((await preview([1, 2])).blocksLost).toBe(1);
      expect((await preview([1, 3])).blocksLost).toBe(0);
      expect((await state("anna")).structures).toHaveLength(1);

      await merge("anna", [1, 2]);
      const after = await state("anna");
      // A block protects one municipality: it does not stretch over the area.
      expect(after.structures).toEqual([]);
      expect(
        await prisma.structure.findMany({
          where: { matchId },
          select: { type: true, active: true },
        }),
      ).toEqual([{ type: "BLOCK", active: false }]);
    });
  });
});
