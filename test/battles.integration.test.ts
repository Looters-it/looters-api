import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { attackCostPct, costOf, planAttack } from "../src/rules/attack.js";
import { EMPIRE_COLORS } from "../src/rules/catalogue.js";
import { DEFAULT_MATCH_RULES } from "../src/rules/config.js";

describe("attack cost", () => {
  it("grows with the territories used, up to the ceiling", () => {
    // Defaults: 50%, +10% for each further territory, never above 100%.
    expect([1, 2, 3, 6, 9].map((n) => attackCostPct(DEFAULT_MATCH_RULES, n))).toEqual([
      50, 60, 70, 100, 100,
    ]);
  });

  it("rounds costs up and counts strength before paying", () => {
    expect(costOf(101, 50)).toBe(51);
    expect(costOf(1, 50)).toBe(1);
    expect(costOf(0, 50)).toBe(0);
    expect(planAttack(DEFAULT_MATCH_RULES, [100, 41])).toEqual({
      pct: 60,
      costs: [60, 25],
      totalCost: 85,
      force: 141,
    });
  });
});

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

interface Battle {
  id: string;
  status: string;
  outcome: string | null;
  role: string | null;
  targetName: string;
  fromTerritoryIds?: string[];
  attackCost?: number;
  attackForce?: number;
  defenseForce?: number;
  defenseCost?: number;
  response?: string | null;
}
interface State {
  territories: { id: string; name: string; resources: number | null; battleId: string | null }[];
  battles: Battle[];
}

describe.skipIf(!url)("battles", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  let matchId: string;
  /** Six municipalities in a row: unit[i] borders unit[i + 1]. */
  let unit: number[];
  const cookies: Record<string, string> = {};
  /** What the api handed to `jobs` for resolution. */
  let handedOver: { battleId: string; matchId: string }[];

  beforeEach(async () => {
    await prisma.job.deleteMany();
    await prisma.match.deleteMany();
    await prisma.geoArea.deleteMany();
    await prisma.user.deleteMany();
    handedOver = [];
    app = await buildApp({
      prisma,
      auth: { registerRateLimit: { max: 1000, windowMs: 60_000 } },
      battleQueue: {
        requestResolution: (message) => {
          handedOver.push(message);
          return Promise.resolve();
        },
      },
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
    for (const name of ["anna", "bruno", "carla"]) {
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
    // Anna holds 0, 1, 2 (100, 41 and 10 resources); Bruno holds 3 (80) and 5; Carla holds 4.
    const players: [string, number, string][] = [
      ["anna", 0, "Anna"],
      ["bruno", 5, "Bruno"],
      ["carla", 4, "Carla"],
    ];
    for (const [index, [user, start, name]] of players.entries()) {
      await as(user, "POST", `/api/matches/${matchId}/join`, {
        geoUnitId: unit[start],
        empire: { name, color: EMPIRE_COLORS[index], emblem: "torre", motto: null },
      });
    }
    await give("Anna", 0, 100);
    await give("Anna", 1, 41);
    await give("Anna", 2, 10);
    await give("Bruno", 3, 80);
    // Turn 2: the protection of the capitals, which lasts through turn 1, is over.
    await prisma.territory.updateMany({ where: { matchId }, data: { protectedUntilTurn: null } });
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "RUNNING", currentTurn: 2, turnEndsAt: new Date(Date.now() + 3_600_000) },
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
  const territoryOf = async (index: number) =>
    (
      await prisma.territoryUnit.findUniqueOrThrow({
        where: { matchId_geoUnitId: { matchId, geoUnitId: unit[index] ?? 0 } },
        include: { territory: true },
      })
    ).territory;
  async function give(empireName: string, index: number, resources: number) {
    const empire = await prisma.empire.findFirstOrThrow({ where: { matchId, name: empireName } });
    await prisma.territory.update({
      where: { id: (await territoryOf(index)).id },
      data: { ownerEmpireId: empire.id, resources },
    });
  }
  const ids = (indexes: number[]) =>
    Promise.all(indexes.map(async (i) => (await territoryOf(i)).id));
  const attack = async (user: string, target: number, from: number[], turn = 2) =>
    as(user, "POST", `/api/matches/${matchId}/attacks`, {
      targetGeoUnitId: unit[target],
      fromTerritoryIds: await ids(from),
      turn,
    });
  const state = async (user: string | null) =>
    (await as(user, "GET", `/api/matches/${matchId}/state`)).json<State>();
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error?: { code: string } }).error?.code;

  describe("declaration", () => {
    it("reserves the cost, fixes both strengths and locks every territory involved", async () => {
      const response = await attack("anna", 3, [2]);
      expect(response.statusCode, response.body).toBe(201);

      const battle = await prisma.battle.findFirstOrThrow({
        include: { sources: true, locks: true },
      });
      expect(battle).toMatchObject({
        status: "OPEN",
        turn: 2,
        attackPct: 50,
        attackCost: 5,
        // Strength is what was there before paying: 10 against 80.
        attackForce: 10,
        defenseForce: 80,
        response: null,
      });
      expect(battle.sources).toMatchObject([{ cost: 5, resourcesAtDeclaration: 10 }]);
      // The cost left the attacking territory at once; the defender has paid nothing yet.
      expect((await territoryOf(2)).resources).toBe(5);
      expect((await territoryOf(3)).resources).toBe(80);
      expect(battle.locks.map((lock) => lock.territoryId).sort()).toEqual(
        (await ids([2, 3])).sort(),
      );
    });

    it("joins the strength of several territories at a progressive cost", async () => {
      // Make Comune 1 a neighbour of the target as well.
      await prisma.geoAdjacency.create({ data: { aId: unit[1] ?? 0, bId: unit[3] ?? 0 } });
      const preview = await as("anna", "POST", `/api/matches/${matchId}/attacks/preview`, {
        targetGeoUnitId: unit[3],
        fromTerritoryIds: await ids([1, 2]),
      });
      // Two territories: 60% of each, rounded up. 41 -> 25, 10 -> 6.
      expect(preview.json()).toMatchObject({ pct: 60, totalCost: 31, force: 51 });
      // Nothing about the defender: only the attacker's own territories and numbers.
      expect(Object.keys(preview.json<object>()).sort()).toEqual([
        "force",
        "from",
        "pct",
        "totalCost",
      ]);
      // A preview changes nothing.
      expect(await prisma.battle.count()).toBe(0);
      expect((await territoryOf(1)).resources).toBe(41);

      await attack("anna", 3, [1, 2]);
      expect((await territoryOf(1)).resources).toBe(16);
      expect((await territoryOf(2)).resources).toBe(4);
      expect(await prisma.battle.findFirstOrThrow()).toMatchObject({
        attackPct: 60,
        attackCost: 31,
        attackForce: 51,
      });
    });

    it("refuses what cannot be attacked or cannot attack", async () => {
      expect(errorCode(await attack("anna", 4, [2]))).toBe("NOT_ADJACENT");
      expect(errorCode(await attack("anna", 1, [0]))).toBe("TARGET_IS_YOURS");
      expect(errorCode(await attack("anna", 3, [5]))).toBe("NOT_YOUR_TERRITORY");
      expect(errorCode(await attack("anna", 3, [2], 1))).toBe("TURN_CHANGED");

      // A municipality nobody owns is annexed, not attacked.
      const free = await territoryOf(3);
      await prisma.territory.update({ where: { id: free.id }, data: { ownerEmpireId: null } });
      expect(errorCode(await attack("anna", 3, [2]))).toBe("TARGET_IS_FREE");
      await give("Bruno", 3, 80);

      // Every territory used must hold at least one resource.
      await give("Anna", 2, 0);
      expect(errorCode(await attack("anna", 3, [2]))).toBe("NOT_ENOUGH_RESOURCES");
      await give("Anna", 2, 10);

      // Just acquired: protected until the end of the turn.
      await prisma.territory.update({ where: { id: free.id }, data: { protectedUntilTurn: 2 } });
      expect(errorCode(await attack("anna", 3, [2]))).toBe("TARGET_PROTECTED");
      expect(await prisma.battle.count()).toBe(0);
      expect((await territoryOf(2)).resources).toBe(10);
    });

    it("blocks resources on the territories involved, and only on those", async () => {
      await attack("anna", 3, [2]);
      const [zero, one, two] = await ids([0, 1, 2]);
      const move = (amounts: Record<string, number>) =>
        as("anna", "POST", `/api/matches/${matchId}/allocate`, { amounts, turn: 2 });

      // Comune 2 is attacking: it can neither give nor receive.
      expect(errorCode(await move({ [one ?? ""]: 46, [two ?? ""]: 0 }))).toBe(
        "TERRITORY_IN_BATTLE",
      );
      // The rest of the empire is free.
      expect((await move({ [zero ?? ""]: 141, [one ?? ""]: 0 })).statusCode).toBe(200);
      // A territory in a battle cannot pay for an annexation either.
      await prisma.territory.update({
        where: { id: (await territoryOf(3)).id },
        data: { resources: 500 },
      });
      const defenderMove = await as("bruno", "POST", `/api/matches/${matchId}/allocate`, {
        amounts: { [(await territoryOf(3)).id]: 0, [(await territoryOf(5)).id]: 9999 },
        turn: 2,
      });
      expect(errorCode(defenderMove)).toBe("TERRITORY_IN_BATTLE");
    });

    it("cannot launch a second attack from, or on, a territory already in a battle", async () => {
      await attack("anna", 3, [2]);
      expect(errorCode(await attack("anna", 3, [2]))).toBe("TERRITORY_IN_BATTLE");
      // Carla, from Comune 4, wants the same target.
      expect(errorCode(await attack("carla", 3, [4]))).toBe("TERRITORY_IN_BATTLE");
      // Bruno's attacked territory cannot be used to attack back.
      expect(errorCode(await attack("bruno", 2, [3]))).toBe("TERRITORY_IN_BATTLE");
    });

    it("lets one empire be attacked on several territories at once, by different empires", async () => {
      // Carla holds Comune 4, between Bruno's 3 and 5.
      expect((await attack("anna", 3, [2])).statusCode).toBe(201);
      expect((await attack("carla", 5, [4])).statusCode).toBe(201);
      const battles = await prisma.battle.findMany();
      expect(battles).toHaveLength(2);
      expect(new Set(battles.map((battle) => battle.defenderEmpireId)).size).toBe(1);
    });
  });

  describe("concurrency", () => {
    it("opens one battle when two empires attack the same territory at the same moment", async () => {
      const carlaBefore = (await territoryOf(4)).resources;
      const [anna, carla] = await Promise.all([attack("anna", 3, [2]), attack("carla", 3, [4])]);
      expect([anna.statusCode, carla.statusCode].sort()).toEqual([201, 409]);
      const loser = anna.statusCode === 409 ? anna : carla;
      expect(errorCode(loser)).toBe("TERRITORY_IN_BATTLE");

      expect(await prisma.battle.count()).toBe(1);
      // Whoever lost the race paid nothing.
      if (loser === anna) expect((await territoryOf(2)).resources).toBe(10);
      else expect((await territoryOf(4)).resources).toBe(carlaBefore);
      expect(await prisma.battleLock.count()).toBe(2);
    });

    it("keeps balances non-negative when the same territory is used twice at once", async () => {
      // Comune 4 borders both of Bruno's territories: Carla tries to use it against both.
      const results = await Promise.all([attack("carla", 3, [4]), attack("carla", 5, [4])]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(await prisma.battle.count()).toBe(1);
      expect((await territoryOf(4)).resources).toBeGreaterThanOrEqual(0);
    });

    it("never moves resources out of a territory while an attack on it is being declared", async () => {
      // Bruno empties Comune 3 into Comune 5 at the very moment Anna attacks it.
      const [three, five] = await ids([3, 5]);
      const total = 80 + (await territoryOf(5)).resources;
      const [attacked, moved] = await Promise.all([
        attack("anna", 3, [2]),
        as("bruno", "POST", `/api/matches/${matchId}/allocate`, {
          amounts: { [three ?? ""]: 0, [five ?? ""]: total },
          turn: 2,
        }),
      ]);
      expect(attacked.statusCode).toBe(201);

      const battle = await prisma.battle.findFirstOrThrow();
      const target = await territoryOf(3);
      // Either the move came first (and the attack found an empty territory) or it was
      // refused: in both cases the recorded strength is what is really on the territory.
      expect(battle.defenseForce).toBe(target.resources);
      expect([200, 409]).toContain(moved.statusCode);
      if (moved.statusCode === 409) expect(errorCode(moved)).toBe("TERRITORY_IN_BATTLE");
    });
  });

  describe("response", () => {
    async function declared() {
      await attack("anna", 3, [2]);
      return (await prisma.battle.findFirstOrThrow()).id;
    }
    const respond = (user: string | null, battleId: string, action: string) =>
      as(user, "POST", `/api/matches/${matchId}/battles/${battleId}/respond`, { action });

    it("records the defender's choice and hands the battle to jobs at once", async () => {
      const battleId = await declared();
      const response = await respond("bruno", battleId, "DEFEND");
      expect(response.statusCode, response.body).toBe(200);

      const battle = await prisma.battle.findUniqueOrThrow({ where: { id: battleId } });
      // The api never decides the outcome: the battle stays open until jobs resolves it.
      expect(battle).toMatchObject({ response: "DEFEND", status: "OPEN", outcome: null });
      expect(battle.respondedAt).not.toBeNull();
      expect(handedOver).toEqual([{ battleId, matchId }]);
    });

    it("accepts a surrender, once, from the defender only", async () => {
      const battleId = await declared();
      expect((await respond(null, battleId, "SURRENDER")).statusCode).toBe(401);
      expect(errorCode(await respond("anna", battleId, "SURRENDER"))).toBe("NOT_THE_DEFENDER");
      expect(errorCode(await respond("carla", battleId, "SURRENDER"))).toBe("NOT_THE_DEFENDER");
      expect((await respond("bruno", battleId, "RETREAT")).statusCode).toBe(400);

      expect((await respond("bruno", battleId, "SURRENDER")).statusCode).toBe(200);
      expect(errorCode(await respond("bruno", battleId, "DEFEND"))).toBe("BATTLE_ANSWERED");
      expect((await prisma.battle.findUniqueOrThrow({ where: { id: battleId } })).response).toBe(
        "SURRENDER",
      );
      expect(handedOver).toHaveLength(1);
      expect((await respond("bruno", "nope", "DEFEND")).statusCode).toBe(404);
    });

    it("still records the answer when jobs cannot be reached", async () => {
      const battleId = await declared();
      const failing = await buildApp({
        prisma,
        battleQueue: { requestResolution: () => Promise.reject(new Error("kafka down")) },
        health: {
          pingDatabase: () => Promise.resolve(),
          lastJobsPongAt: () => null,
          battleQueueConnected: () => false,
        },
      });
      const response = await failing.inject({
        method: "POST",
        url: `/api/matches/${matchId}/battles/${battleId}/respond`,
        payload: { action: "DEFEND" },
        headers: { cookie: cookies.bruno ?? "" },
      });
      await failing.close();
      // The turn close will resolve it with this answer.
      expect(response.statusCode).toBe(200);
      expect((await prisma.battle.findUniqueOrThrow({ where: { id: battleId } })).response).toBe(
        "DEFEND",
      );
    });
  });

  describe("what each side sees", () => {
    it("shows the battle to everyone, and to each side only its own numbers", async () => {
      await attack("anna", 3, [2]);
      const [two, three] = await ids([2, 3]);

      const attacker = (await state("anna")).battles[0];
      expect(attacker).toMatchObject({
        role: "attacker",
        status: "OPEN",
        targetName: "Comune 3",
        fromTerritoryIds: [two],
        attackCost: 5,
        attackForce: 10,
      });
      expect(attacker).not.toHaveProperty("defenseForce");
      expect(attacker).not.toHaveProperty("defenseCost");

      const defender = (await state("bruno")).battles[0];
      // Defending costs half of what is on the attacked territory: 40 of 80.
      expect(defender).toMatchObject({
        role: "defender",
        defenseForce: 80,
        defenseCost: 40,
        response: null,
      });
      expect(defender).not.toHaveProperty("attackForce");
      expect(defender).not.toHaveProperty("attackCost");
      expect(defender).not.toHaveProperty("fromTerritoryIds");
      expect((await state("bruno")).territories.find((t) => t.id === two)?.battleId).toBeNull();
      expect((await state("anna")).territories.find((t) => t.id === two)?.battleId).toBe(
        attacker?.id,
      );

      for (const viewer of ["carla", null]) {
        const seen = await state(viewer);
        expect(seen.battles[0]).toMatchObject({
          role: null,
          status: "OPEN",
          targetName: "Comune 3",
        });
        expect(Object.keys(seen.battles[0] ?? {}).sort()).toEqual(
          [
            "attackerEmpireId",
            "defenderEmpireId",
            "id",
            "outcome",
            "role",
            "status",
            "targetName",
            "targetTerritoryId",
            "turn",
          ].sort(),
        );
        // The attacked territory is marked for everyone.
        expect(seen.territories.find((t) => t.id === three)?.battleId).toBe(attacker?.id);
        // Where the attack comes from is the attacker's business.
        expect(seen.territories.find((t) => t.id === two)?.battleId).toBeNull();
      }
    });

    it("tells a player whether a territory can be attacked and from where", async () => {
      const card = async (user: string, index: number) =>
        (await as(user, "GET", `/api/matches/${matchId}/units/${unit[index]}`)).json<{
          attack: { blocked: string | null; from: { name: string; usable: boolean }[] } | null;
          territory: { inBattle: boolean; resources: number | null };
        }>();

      expect((await card("anna", 3)).attack).toEqual({
        blocked: null,
        from: [{ territoryId: (await ids([2]))[0], name: "Comune 2", resources: 10, usable: true }],
      });
      expect((await card("anna", 5)).attack).toMatchObject({ blocked: "NOT_ADJACENT", from: [] });
      // Own territories and free ones are not attacked; guests cannot attack.
      expect((await card("anna", 1)).attack).toBeNull();
      expect((await card("", 3)).attack).toBeNull();

      await attack("anna", 3, [2]);
      const underAttack = await card("carla", 3);
      expect(underAttack.attack).toMatchObject({ blocked: "IN_BATTLE" });
      expect(underAttack.territory).toMatchObject({ inBattle: true, resources: null });
    });
  });
});
