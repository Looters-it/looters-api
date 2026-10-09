import type { AddressInfo } from "node:net";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { EMPIRE_COLORS } from "../src/rules/catalogue.js";

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

interface State {
  me: { empireId: string; annexLeft: number; turnValue: number; allocationMode: string } | null;
  empires: { id: string; name: string; units: number }[];
  territories: {
    id: string;
    name: string;
    ownerEmpireId: string;
    geoUnitIds: number[];
    resources: number | null;
    protected: boolean;
    weight: number | null;
  }[];
  online: { connected: number; total: number };
}

describe.skipIf(!url)("turns, resources and annexations", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  let matchId: string;
  /** Six municipalities in a row: unit[i] borders unit[i + 1]. */
  let unit: number[];
  const cookies: Record<string, string> = {};
  const sockets: WebSocket[] = [];

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
    await app.listen({ port: 0, host: "127.0.0.1" });

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

    // Anna on Comune 0 and Bruno on Comune 5, then the match starts at turn 1.
    const created = await as("anna", "POST", "/api/matches", {
      name: "Partita",
      areaIds: [area.id],
      startAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    matchId = created.json<{ id: string }>().id;
    await as("anna", "POST", `/api/matches/${matchId}/join`, {
      geoUnitId: unit[0],
      empire: { name: "Anna", color: EMPIRE_COLORS[0], emblem: "torre", motto: null },
    });
    await as("bruno", "POST", `/api/matches/${matchId}/join`, {
      geoUnitId: unit[5],
      empire: { name: "Bruno", color: EMPIRE_COLORS[1], emblem: "luna", motto: null },
    });
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "ONGOING", currentTurn: 1, turnEndsAt: new Date(Date.now() + 3_600_000) },
    });
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
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
  const territoryOf = async (index: number) =>
    (
      await prisma.territoryUnit.findUniqueOrThrow({
        where: { matchId_geoUnitId: { matchId, geoUnitId: unit[index] ?? 0 } },
        include: { territory: true },
      })
    ).territory;
  const annex = async (user: string, target: number, payFrom: number, turn = 1) =>
    as(user, "POST", `/api/matches/${matchId}/annex`, {
      geoUnitId: unit[target],
      payFromTerritoryId: (await territoryOf(payFrom)).id,
      turn,
    });
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error?: { code: string } }).error?.code;

  describe("annexation", () => {
    it("gives the new territory the average weight of those the empire already has", async () => {
      const capital = await territoryOf(0);
      await prisma.territory.update({ where: { id: capital.id }, data: { weight: 6 } });
      expect((await annex("anna", 1, 0)).statusCode).toBe(200);
      expect((await territoryOf(1)).weight).toBe(6);
    });

    it("takes a free neighbour at once, for the fixed cost, with its hidden resources", async () => {
      const capital = await territoryOf(0);
      const target = await territoryOf(1);

      const response = await annex("anna", 1, 0);
      expect(response.statusCode, response.body).toBe(200);
      const after = response.json<State>();

      const mine = after.territories.filter((t) => t.ownerEmpireId === after.me?.empireId);
      expect(mine).toHaveLength(2);
      // The capital paid 50; the new territory keeps what was hidden on it, now revealed to Anna.
      expect(mine.find((t) => t.id === capital.id)?.resources).toBe(capital.resources - 50);
      expect(mine.find((t) => t.id === target.id)).toMatchObject({
        resources: target.resources,
        protected: true,
      });
      expect(after.me).toMatchObject({ annexLeft: 0, turnValue: 50 + 10 * 2 });
      expect(after.empires.find((e) => e.name === "Anna")?.units).toBe(2);

      const event = await prisma.gameEvent.findFirstOrThrow({ where: { type: "ANNEXED" } });
      expect(event.data).toEqual({ empireName: "Anna", territoryName: "Comune 1" });
    });

    it("allows one annexation per turn", async () => {
      await annex("anna", 1, 0);
      const second = await annex("anna", 2, 1);
      expect(second.statusCode).toBe(409);
      expect(errorCode(second)).toBe("ANNEX_LIMIT");
      expect((await territoryOf(2)).ownerEmpireId).toBeNull();
    });

    it("needs the cost on the paying territory and never leaves a balance negative", async () => {
      const capital = await territoryOf(0);
      await prisma.territory.update({ where: { id: capital.id }, data: { resources: 49 } });

      const response = await annex("anna", 1, 0);
      expect(errorCode(response)).toBe("NOT_ENOUGH_RESOURCES");
      expect((await territoryOf(0)).resources).toBe(49);
      expect((await territoryOf(1)).ownerEmpireId).toBeNull();
    });

    it("refuses targets that are not free neighbours of the paying territory", async () => {
      expect(errorCode(await annex("anna", 3, 0))).toBe("NOT_ADJACENT");
      // Bruno's capital is not free; paying from someone else's territory is not allowed.
      await prisma.empire.updateMany({ data: { annexedThisTurn: 0 } });
      await annex("bruno", 4, 5);
      expect(errorCode(await annex("anna", 4, 0))).toBe("TERRITORY_TAKEN");
      expect(errorCode(await annex("anna", 1, 5))).toBe("NOT_YOUR_TERRITORY");
    });

    it("refuses guests, spectators, a stale turn and a match that is not running", async () => {
      const body = { geoUnitId: unit[1], payFromTerritoryId: (await territoryOf(0)).id, turn: 1 };
      expect((await as(null, "POST", `/api/matches/${matchId}/annex`, body)).statusCode).toBe(401);
      expect(errorCode(await as("carla", "POST", `/api/matches/${matchId}/annex`, body))).toBe(
        "NOT_A_PLAYER",
      );
      // Decided during turn 1, sent after turn 2 began.
      await prisma.match.update({ where: { id: matchId }, data: { currentTurn: 2 } });
      expect(errorCode(await annex("anna", 1, 0, 1))).toBe("TURN_CHANGED");
      await prisma.match.update({ where: { id: matchId }, data: { status: "PLANNED" } });
      expect(errorCode(await annex("anna", 1, 0, 2))).toBe("MATCH_NOT_RUNNING");
    });

    it("gives a municipality wanted by two empires to one, and the other pays nothing", async () => {
      // Make Comune 3 a neighbour of both: Anna holds 0-1-2, Bruno 5-4.
      for (const [index, owner] of [
        [1, "Anna"],
        [2, "Anna"],
        [4, "Bruno"],
      ] as const) {
        const empire = await prisma.empire.findFirstOrThrow({ where: { name: owner } });
        await prisma.territory.update({
          where: { id: (await territoryOf(index)).id },
          data: { ownerEmpireId: empire.id, resources: 100 },
        });
      }

      const [a, b] = await Promise.all([annex("anna", 3, 2), annex("bruno", 3, 4)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect(errorCode(a.statusCode === 409 ? a : b)).toBe("TERRITORY_TAKEN");

      const winner = a.statusCode === 200 ? "Anna" : "Bruno";
      const loserIndex = winner === "Anna" ? 4 : 2;
      expect((await territoryOf(loserIndex)).resources).toBe(100); // nothing was spent
      const loser = await prisma.empire.findFirstOrThrow({ where: { name: { not: winner } } });
      expect(loser.annexedThisTurn).toBe(0); // and the annexation of the turn is still available
    });

    it("cannot overdraw a territory with simultaneous annexations", async () => {
      // Anna may annex twice this turn, but the capital can afford only one.
      await prisma.match.update({
        where: { id: matchId },
        data: {
          config: {
            ...((await prisma.match.findUniqueOrThrow({ where: { id: matchId } }))
              .config as object),
            annexPerTurn: 5,
          },
        },
      });
      const one = await territoryOf(1);
      const anna = await prisma.empire.findFirstOrThrow({ where: { name: "Anna" } });
      await prisma.territory.update({
        where: { id: one.id },
        data: { ownerEmpireId: anna.id, resources: 60 },
      });
      await prisma.geoAdjacency.create({ data: { aId: unit[1] ?? 0, bId: unit[3] ?? 0 } });

      // Two targets, both paid by Comune 1, which holds 60.
      const results = await Promise.all([annex("anna", 2, 1), annex("anna", 3, 1)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect((await territoryOf(1)).resources).toBe(10);
    });
  });

  describe("unit card", () => {
    it("lists the neighbours and how a free one can be annexed", async () => {
      const card = (await as("anna", "GET", `/api/matches/${matchId}/units/${unit[1]}`)).json<{
        name: string;
        territory: { ownerEmpireId: string | null; resources: number | null };
        neighbours: { name: string; ownerEmpireId: string | null }[];
        annex: { cost: number; left: number; payFrom: { name: string; usable: boolean }[] } | null;
      }>();
      expect(card.name).toBe("Comune 1");
      // A free municipality: its hidden resources are not shown, even to a neighbour.
      expect(card.territory).toMatchObject({ ownerEmpireId: null, resources: null });
      expect(card.neighbours.map((n) => n.name)).toEqual(["Comune 0", "Comune 2"]);
      expect(card.annex).toMatchObject({
        cost: 50,
        left: 1,
        payFrom: [{ name: "Comune 0", usable: true }],
      });
    });

    it("shows resources only to the owner and no annexation to others", async () => {
      const route = `/api/matches/${matchId}/units/${unit[0]}`;
      const own = (await as("anna", "GET", route)).json<{ territory: { resources: number } }>();
      expect(own.territory.resources).toBeGreaterThan(200);

      for (const user of ["bruno", "carla", null]) {
        const other = await as(user, "GET", route);
        expect(other.json<{ territory: { resources: unknown } }>().territory.resources).toBeNull();
        expect(other.json<{ annex: unknown }>().annex).toBeNull();
      }
      const farFree = await as("bruno", "GET", `/api/matches/${matchId}/units/${unit[1]}`);
      // Not adjacent to Bruno: nothing can pay for it.
      expect(farFree.json<{ annex: { payFrom: unknown[] } }>().annex.payFrom).toEqual([]);
    });
  });

  describe("resources", () => {
    async function twoTerritories() {
      await annex("anna", 1, 0);
      const mine = (await state("anna")).territories.filter((t) => t.resources !== null);
      const named = (name: string) => {
        const territory = mine.find((t) => t.name === name);
        if (!territory) throw new Error(`${name} is not Anna's`);
        return territory;
      };
      return { capital: named("Comune 0"), second: named("Comune 1") };
    }
    const allocate = (user: string, amounts: Record<string, number>, turn = 1) =>
      as(user, "POST", `/api/matches/${matchId}/allocate`, { amounts, turn });

    it("moves resources between own territories, keeping the total", async () => {
      const { capital, second } = await twoTerritories();
      const total = (capital.resources ?? 0) + (second.resources ?? 0);

      const response = await allocate("anna", { [capital.id]: 10, [second.id]: total - 10 });
      expect(response.statusCode, response.body).toBe(200);
      const after = response.json<State>().territories;
      expect(after.find((t) => t.id === capital.id)?.resources).toBe(10);
      expect(after.find((t) => t.id === second.id)?.resources).toBe(total - 10);
    });

    it("refuses a different total, negative amounts and territories of others", async () => {
      const { capital, second } = await twoTerritories();
      const total = (capital.resources ?? 0) + (second.resources ?? 0);
      expect(errorCode(await allocate("anna", { [capital.id]: total, [second.id]: 1 }))).toBe(
        "ALLOCATION_SUM",
      );
      expect(
        (await allocate("anna", { [capital.id]: total + 5, [second.id]: -5 })).statusCode,
      ).toBe(400);
      const brunoCapital = await territoryOf(5);
      expect(errorCode(await allocate("anna", { [capital.id]: 1, [brunoCapital.id]: total }))).toBe(
        "NOT_YOUR_TERRITORY",
      );
      expect(errorCode(await allocate("anna", { [capital.id]: capital.resources ?? 0 }, 9))).toBe(
        "TURN_CHANGED",
      );
      expect((await territoryOf(5)).resources).toBe(brunoCapital.resources);
    });

    it("does not move resources of a territory in a battle", async () => {
      const { capital, second } = await twoTerritories();
      const battle = await prisma.battle.create({
        data: {
          matchId,
          turn: 1,
          attackerEmpireId: "x",
          defenderEmpireId: "y",
          targetTerritoryId: second.id,
          attackPct: 50,
          attackCost: 1,
          attackForce: 1,
        },
      });
      await prisma.battleLock.create({ data: { territoryId: second.id, battleId: battle.id } });
      const total = (capital.resources ?? 0) + (second.resources ?? 0);
      expect(errorCode(await allocate("anna", { [capital.id]: total, [second.id]: 0 }))).toBe(
        "TERRITORY_IN_BATTLE",
      );
    });

    it("stores the rule that splits each turn's income", async () => {
      const { capital, second } = await twoTerritories();
      expect((await state("anna")).me?.allocationMode).toBe("EQUAL");

      const response = await as("anna", "PUT", `/api/matches/${matchId}/allocation-rule`, {
        mode: "WEIGHTED",
        weights: { [capital.id]: 3, [second.id]: 1 },
      });
      const after = response.json<State>();
      expect(after.me?.allocationMode).toBe("WEIGHTED");
      expect(after.territories.find((t) => t.id === capital.id)?.weight).toBe(3);
      // Weights are private, like resources.
      expect(
        (await state("bruno")).territories.every((t) =>
          t.ownerEmpireId === after.me?.empireId ? t.weight === null : true,
        ),
      ).toBe(true);

      const notMine = await as("bruno", "PUT", `/api/matches/${matchId}/allocation-rule`, {
        mode: "WEIGHTED",
        weights: { [capital.id]: 9 },
      });
      expect(errorCode(notMine)).toBe("NOT_YOUR_TERRITORY");
    });
  });

  it("never lets an amount of another empire, or of a free municipality, reach a client", async () => {
    await annex("anna", 1, 0);
    const hidden = (await prisma.territory.findMany({ where: { matchId } })).map(
      (t) => t.resources,
    );

    for (const viewer of ["bruno", "carla", null]) {
      const seen = await state(viewer);
      const anna = seen.empires.find((e) => e.name === "Anna");
      for (const territory of seen.territories.filter((t) => t.ownerEmpireId === anna?.id)) {
        expect(territory.resources).toBeNull();
        expect(territory.weight).toBeNull();
      }
      // Free municipalities are not in the state at all.
      expect(seen.territories.every((t) => t.ownerEmpireId)).toBe(true);
    }
    // The events, public by nature, carry names only: no number at all in their data.
    // (Ids and timestamps are left out: they contain digits by nature.)
    const events = await prisma.gameEvent.findMany({ where: { matchId }, select: { data: true } });
    expect(hidden.length).toBeGreaterThan(0);
    expect(JSON.stringify(events.map((event) => event.data))).not.toMatch(/\d{2,}/);
  });

  describe("live updates", () => {
    async function follow(user: string | null) {
      const { port } = app.server.address() as AddressInfo;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: user ? { cookie: cookies[user] ?? "" } : {},
      });
      sockets.push(socket);
      const messages: { t: string; kinds?: string[]; connected?: number }[] = [];
      socket.on("message", (data) => {
        messages.push(JSON.parse((data as Buffer).toString("utf8")) as (typeof messages)[number]);
      });
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(JSON.stringify({ t: "sub", matchId }));
      return { socket, messages };
    }
    const until = (condition: () => boolean) =>
      expect.poll(condition, { timeout: 3000, interval: 10 }).toBe(true);
    const online = (messages: { t: string; connected?: number }[]) =>
      messages.filter((m) => m.t === "match.online").at(-1)?.connected;

    it("tells the followers of a match when something changes in it", async () => {
      const guest = await follow(null);
      const bruno = await follow("bruno");
      await until(() => online(bruno.messages) === 1);

      await annex("anna", 1, 0);
      await until(() => guest.messages.some((m) => m.t === "match.update"));
      await until(() => bruno.messages.some((m) => m.t === "match.update"));
      expect(guest.messages.find((m) => m.t === "match.update")).toMatchObject({
        matchId,
        kinds: ["territories"],
      });
      // A notification is only a hint: it carries no data of the match.
      expect(JSON.stringify(guest.messages)).not.toContain('resources":');
    });

    it("counts the players of the match who are watching it, not guests or spectators", async () => {
      const guest = await follow(null);
      await follow("carla"); // registered, but without an empire here
      await until(() => online(guest.messages) === 0);

      const anna = await follow("anna");
      await follow("anna"); // a second tab counts once
      await until(() => online(guest.messages) === 1);
      const bruno = await follow("bruno");
      await until(() => online(guest.messages) === 2);
      expect((await state(null)).online).toEqual({ connected: 2, total: 2 });

      bruno.socket.close();
      await until(() => online(guest.messages) === 1);
      anna.socket.send(JSON.stringify({ t: "unsub", matchId }));
      // Anna's other tab still follows the match.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(online(guest.messages)).toBe(1);
    });
  });
});
