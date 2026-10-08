import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { BOARD_KINDS } from "../src/modules/board/service.js";
import { EMPIRE_COLORS } from "../src/rules/catalogue.js";
import { DEFAULT_MATCH_RULES } from "../src/rules/config.js";
import { seedAdmin } from "../src/seed/admin.js";

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

interface Entry {
  id: string;
  type: string;
  turn: number;
  empireId: string | null;
  territoryId: string | null;
  geoUnitId: number | null;
  data: Record<string, unknown>;
}

describe.skipIf(!url)("board", () => {
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
    for (const name of ["anna", "bruno", "carla"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: name, email: `${name}@example.test`, password: "password-123" },
      });
      cookies[name] = `sid=${response.cookies.find((c) => c.name === "sid")?.value ?? ""}`;
    }
    await seedAdmin(prisma, {
      username: "admin",
      email: "a@example.test",
      password: "x".repeat(12),
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "x".repeat(12) },
    });
    cookies.admin = `sid=${login.cookies.find((c) => c.name === "sid")?.value ?? ""}`;

    // Anna owns the match. No waiting between messages, unless a test asks for it.
    const created = await as("anna", "POST", "/api/matches", {
      name: "Partita",
      areaIds: [area.id],
      startAt: new Date(Date.now() + 86_400_000).toISOString(),
      config: { boardMessageIntervalSec: 0 },
    });
    matchId = created.json<{ id: string }>().id;
    await as("anna", "POST", `/api/matches/${matchId}/open`);
    for (const [index, [user, start]] of (
      [
        ["anna", 0],
        ["bruno", 3],
      ] as const
    ).entries()) {
      await as(user, "POST", `/api/matches/${matchId}/join`, {
        geoUnitId: unit[start],
        empire: {
          name: `Impero di ${user}`,
          color: EMPIRE_COLORS[index],
          emblem: "torre",
          motto: null,
        },
      });
    }
    await prisma.match.update({
      where: { id: matchId },
      data: { status: "RUNNING", currentTurn: 1, turnEndsAt: new Date(Date.now() + 3_600_000) },
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
  const board = async (user: string | null, query = "") =>
    (await as(user, "GET", `/api/matches/${matchId}/board${query}`)).json<Entry[]>();
  const post = (user: string | null, text: string) =>
    as(user, "POST", `/api/matches/${matchId}/board`, { text });
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error?: { code: string } }).error?.code;
  const territoryId = async (index: number) =>
    (
      await prisma.territoryUnit.findUniqueOrThrow({
        where: { matchId_geoUnitId: { matchId, geoUnitId: unit[index] ?? 0 } },
      })
    ).territoryId;

  it("announces what happens in the match, newest first, to anyone", async () => {
    await as("anna", "POST", `/api/matches/${matchId}/annex`, {
      geoUnitId: unit[1],
      payFromTerritoryId: await territoryId(0),
      turn: 1,
    });

    for (const viewer of ["bruno", "carla", null]) {
      const entries = await board(viewer);
      expect(entries.map((entry) => entry.type)).toEqual([
        "ANNEXED",
        "EMPIRE_CREATED",
        "EMPIRE_CREATED",
      ]);
      expect(entries[0]).toMatchObject({
        turn: 1,
        data: { empireName: "Impero di anna", territoryName: "Comune 1" },
        // The municipality to centre the map on.
        geoUnitId: unit[1],
      });
    }
    // What is not an announcement stays off the board.
    expect((await board(null)).some((entry) => entry.type === "MATCH_OPENED")).toBe(false);
  });

  it("never carries an amount: every value of an announcement is a name or a code", async () => {
    const anna = await prisma.empire.findFirstOrThrow({
      where: { matchId, name: "Impero di anna" },
    });
    // One event of every kind the game produces, as api and jobs write them.
    const names = { empireName: "A", territoryName: "T" };
    const samples: [string, object][] = [
      [
        "BATTLE_RESOLVED",
        {
          attackerName: "A",
          defenderName: "B",
          territoryName: "T",
          outcome: "SURRENDER",
          defenderEmpireId: "x",
        },
      ],
      ["EMPIRE_FALLEN", { empireName: "B", byEmpireName: "A" }],
      ["CAPITAL_BUILT", names],
      ["CAPITAL_MOVED", names],
      ["CAPITAL_PROMOTED", names],
      ["AREA_CREATED", names],
      ["AREA_RENAMED", names],
      ["MATCH_STARTED", {}],
      ["MATCH_FINISHED", { winnerName: "A" }],
    ];
    for (const [type, data] of samples) {
      await prisma.gameEvent.create({ data: { matchId, turn: 1, type, empireId: anna.id, data } });
    }
    await as("anna", "POST", `/api/matches/${matchId}/annex`, {
      geoUnitId: unit[1],
      payFromTerritoryId: await territoryId(0),
      turn: 1,
    });

    const allowed = new Set([
      "empireName",
      "territoryName",
      "attackerName",
      "defenderName",
      "byEmpireName",
      "winnerName",
      "outcome",
      "defenderEmpireId",
      "text",
    ]);
    const entries = await board(null, "?limit=100");
    expect(new Set(entries.map((entry) => entry.type)).size).toBeGreaterThanOrEqual(11);
    for (const entry of entries) {
      for (const [key, value] of Object.entries(entry.data)) {
        expect(allowed.has(key), `${entry.type}.${key}`).toBe(true);
        expect(typeof value, `${entry.type}.${key}`).toBe("string");
      }
      // No field of the envelope is an amount either.
      expect(Object.keys(entry).sort()).toEqual([
        "createdAt",
        "data",
        "empireId",
        "geoUnitId",
        "id",
        "territoryId",
        "turn",
        "type",
      ]);
    }
    // Every kind of the board is made of types that are announced.
    expect(Object.values(BOARD_KINDS).flat()).toContain("BATTLE_RESOLVED");
  });

  describe("history of the turns", () => {
    interface Turn {
      turn: number;
      events: Entry[];
      ownership: Record<string, string>;
    }
    // What jobs does when a turn closes: the snapshot of who owns what, then the next turn.
    const closeTurn = async () => {
      await prisma.$executeRaw`
        INSERT INTO "TurnSnapshot" ("matchId", turn, ownership)
        SELECT m.id, m."currentTurn",
          coalesce(jsonb_object_agg(tu."geoUnitId"::text, t."ownerEmpireId"), '{}'::jsonb)
        FROM "Match" m
        JOIN "Territory" t ON t."matchId" = m.id AND t."ownerEmpireId" IS NOT NULL
        JOIN "TerritoryUnit" tu ON tu."territoryId" = t.id
        WHERE m.id = ${matchId} GROUP BY m.id`;
      await prisma.match.update({
        where: { id: matchId },
        data: { currentTurn: { increment: 1 } },
      });
    };
    it("lists the closed turns, newest first, and not the one being played", async () => {
      await closeTurn();
      await post("anna", "Un messaggio nel secondo turno");
      await closeTurn();

      const turns = (await as(null, "GET", `/api/matches/${matchId}/history`)).json<
        { turn: number; events: number; closedAt: string }[]
      >();
      expect(turns.map((entry) => entry.turn)).toEqual([2, 1]);
      // Messages are not part of the history: the second turn had nothing else.
      expect(turns[0]?.events).toBe(0);
      expect(turns[1]?.events).toBeGreaterThan(0);
    });

    it("gives the events of a turn in order and who owned what when it ended", async () => {
      const empires = await prisma.empire.findMany({ where: { matchId } });
      const anna = empires.find((empire) => empire.name === "Impero di anna");
      const bruno = empires.find((empire) => empire.name === "Impero di bruno");
      const payFrom = await territoryId(0);
      await prisma.territory.update({ where: { id: payFrom }, data: { resources: 5000 } });

      await closeTurn();
      const annexed = await as("anna", "POST", `/api/matches/${matchId}/annex`, {
        geoUnitId: unit[1],
        payFromTerritoryId: payFrom,
        turn: 2,
      });
      expect(annexed.statusCode).toBeLessThan(300);
      await closeTurn();

      const first = (await as(null, "GET", `/api/matches/${matchId}/history/1`)).json<Turn>();
      expect(first.ownership).toEqual({
        [String(unit[0])]: anna?.id,
        [String(unit[3])]: bruno?.id,
      });
      const second = (await as("bruno", "GET", `/api/matches/${matchId}/history/2`)).json<Turn>();
      expect(second.ownership[String(unit[1])]).toBe(anna?.id);
      expect(second.events.map((event) => event.type)).toEqual(["ANNEXED"]);
      expect(second.events[0]?.geoUnitId).toBe(unit[1]);
      // The past is not rewritten by what came after.
      expect(first.ownership[String(unit[1])]).toBeUndefined();
    });

    it("never carries resources: only names, outcomes and owners", async () => {
      await closeTurn();
      const response = await as("bruno", "GET", `/api/matches/${matchId}/history/1`);
      const turn = response.json<Turn>();
      expect(Object.keys(turn).sort()).toEqual(["closedAt", "events", "ownership", "turn"]);
      for (const event of turn.events) {
        expect(Object.keys(event).sort()).toEqual(
          [
            "createdAt",
            "data",
            "empireId",
            "geoUnitId",
            "id",
            "territoryId",
            "turn",
            "type",
          ].sort(),
        );
        for (const value of Object.values(event.data)) expect(typeof value).toBe("string");
      }
      for (const owner of Object.values(turn.ownership)) expect(typeof owner).toBe("string");
    });

    it("answers 404 for the turn being played, a turn never played and a draft", async () => {
      await closeTurn();
      const status = async (route: string) => (await as(null, "GET", route)).statusCode;
      expect(await status(`/api/matches/${matchId}/history/2`)).toBe(404);
      expect(await status(`/api/matches/${matchId}/history/99`)).toBe(404);
      expect(await status(`/api/matches/${matchId}/history/0`)).toBe(400);
      await prisma.match.update({ where: { id: matchId }, data: { status: "DRAFT" } });
      expect(await status(`/api/matches/${matchId}/history`)).toBe(404);
      expect(await status(`/api/matches/${matchId}/history/1`)).toBe(404);
    });
  });

  describe("messages", () => {
    it("posts a message in the name of the player's empire", async () => {
      const response = await post("anna", "  Di qua dal fiume non si passa.  ");
      expect(response.statusCode, response.body).toBe(201);
      const [latest] = await board("bruno");
      expect(latest).toMatchObject({
        type: "MESSAGE",
        data: { empireName: "Impero di anna", text: "Di qua dal fiume non si passa." },
      });
      const anna = await prisma.empire.findFirstOrThrow({
        where: { matchId, name: "Impero di anna" },
      });
      expect(latest?.empireId).toBe(anna.id);
    });

    it("limits the length to what the match allows", async () => {
      expect((await post("anna", "x".repeat(500))).statusCode).toBe(201);
      expect(errorCode(await post("anna", "x".repeat(501)))).toBe("MESSAGE_TOO_LONG");
      expect((await post("anna", "   ")).statusCode).toBe(400);
    });

    it("makes an empire wait between two messages", async () => {
      await prisma.match.update({
        where: { id: matchId },
        data: { config: { ...DEFAULT_MATCH_RULES, boardMessageIntervalSec: 30 } },
      });
      expect((await post("anna", "Primo")).statusCode).toBe(201);
      const second = await post("anna", "Secondo");
      expect(second.statusCode).toBe(429);
      expect(errorCode(second)).toBe("RATE_LIMITED");
      expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
      // The limit is per empire: another one can write.
      expect((await post("bruno", "Anch'io")).statusCode).toBe(201);

      // Half a minute later Anna can write again.
      await prisma.gameEvent.updateMany({
        where: { matchId, type: "MESSAGE" },
        data: { createdAt: new Date(Date.now() - 31_000) },
      });
      expect((await post("anna", "Secondo")).statusCode).toBe(201);
    });

    it("lets only empires still in play write: guests, spectators and the fallen only read", async () => {
      expect((await post(null, "Ciao")).statusCode).toBe(401);
      expect(errorCode(await post("carla", "Ciao"))).toBe("NOT_A_PLAYER");

      await prisma.empire.updateMany({
        where: { matchId, name: "Impero di bruno" },
        data: { status: "FALLEN", fallenTurn: 1, capitalTerritoryId: null },
      });
      expect(errorCode(await post("bruno", "Tornerò"))).toBe("EMPIRE_FALLEN");
      // But he can still read.
      expect((await as("bruno", "GET", `/api/matches/${matchId}/board`)).statusCode).toBe(200);

      await prisma.match.update({ where: { id: matchId }, data: { status: "FINISHED" } });
      expect(errorCode(await post("anna", "Fine"))).toBe("MATCH_NOT_RUNNING");
    });

    it("can be removed by the owner of the match and by the platform admin, nobody else", async () => {
      await post("bruno", "Primo messaggio");
      await post("bruno", "Secondo messaggio");
      const [second, first] = await board(null, "?kind=messages");
      const remove = (user: string | null, id: string) =>
        as(user, "DELETE", `/api/matches/${matchId}/board/${id}`);

      expect((await remove(null, first?.id ?? "")).statusCode).toBe(401);
      // Not even its author, unless they own the match.
      expect((await remove("bruno", first?.id ?? "")).statusCode).toBe(403);
      expect((await remove("anna", first?.id ?? "")).statusCode).toBe(204);
      expect((await remove("admin", second?.id ?? "")).statusCode).toBe(204);
      expect(await board(null, "?kind=messages")).toEqual([]);
      expect((await remove("anna", first?.id ?? "")).statusCode).toBe(404);

      // Automatic announcements are the record of what happened: they stay.
      const [announcement] = await board(null);
      expect((await remove("anna", announcement?.id ?? "")).statusCode).toBe(404);
    });
  });

  describe("filters", () => {
    beforeEach(async () => {
      await post("anna", "Saluti da Anna");
      await post("bruno", "Saluti da Bruno");
      const empireOf = (user: string) =>
        prisma.empire.findFirstOrThrow({ where: { matchId, name: `Impero di ${user}` } });
      const anna = await empireOf("anna");
      const bruno = await empireOf("bruno");
      await prisma.gameEvent.create({
        data: {
          matchId,
          turn: 1,
          type: "BATTLE_RESOLVED",
          empireId: anna.id,
          territoryId: await territoryId(3),
          data: {
            attackerName: anna.name,
            defenderName: bruno.name,
            territoryName: "Comune 3",
            outcome: "DEFENDER_WON",
            defenderEmpireId: bruno.id,
          },
        },
      });
    });

    it("filters by kind", async () => {
      expect((await board(null, "?kind=messages")).map((e) => e.data.text)).toEqual([
        "Saluti da Bruno",
        "Saluti da Anna",
      ]);
      expect((await board(null, "?kind=battles")).map((e) => e.type)).toEqual(["BATTLE_RESOLVED"]);
      expect(await board(null, "?kind=empires")).toHaveLength(2);
      expect(await board(null, "?kind=alliances")).toEqual([]);
      expect((await as(null, "GET", `/api/matches/${matchId}/board?kind=nope`)).statusCode).toBe(
        400,
      );
    });

    it("filters by empire, on either side of a battle", async () => {
      const bruno = await prisma.empire.findFirstOrThrow({
        where: { matchId, name: "Impero di bruno" },
      });
      const entries = await board(null, `?empireId=${bruno.id}`);
      // His message, his founding, and the battle where he was the defender.
      expect(entries.map((entry) => entry.type).sort()).toEqual([
        "BATTLE_RESOLVED",
        "EMPIRE_CREATED",
        "MESSAGE",
      ]);
      expect(await board(null, `?empireId=${bruno.id}&kind=battles`)).toHaveLength(1);
    });

    it("pages back in time", async () => {
      const firstPage = await board(null, "?limit=2");
      expect(firstPage).toHaveLength(2);
      const older = await board(null, `?limit=10&before=${firstPage[1]?.id}`);
      expect(older).toHaveLength(3);
      expect(older.some((entry) => firstPage.some((seen) => seen.id === entry.id))).toBe(false);
    });
  });

  it("does not exist for a draft seen by someone else", async () => {
    const draft = await as("bruno", "POST", "/api/matches", {
      name: "Bozza",
      areaIds: [(await prisma.geoArea.findFirstOrThrow()).id],
      startAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const id = draft.json<{ id: string }>().id;
    expect((await as("anna", "GET", `/api/matches/${id}/board`)).statusCode).toBe(404);
  });
});
