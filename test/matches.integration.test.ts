import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { EMPIRE_COLORS, EMPIRE_EMBLEMS, MAX_PLAYERS_LIMIT } from "../src/rules/catalogue.js";
import { DEFAULT_MATCH_RULES } from "../src/rules/config.js";
import { drawHiddenResources } from "../src/rules/hidden-resources.js";

describe("hidden starting resources", () => {
  // A small deterministic generator, so the test is repeatable.
  function seeded(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 2 ** 32;
      return state / 2 ** 32;
    };
  }
  const draws = (rules = DEFAULT_MATCH_RULES, count = 20_000) => {
    const random = seeded(42);
    return Array.from({ length: count }, () => drawHiddenResources(rules, random));
  };

  it("stays between the limits and favours the middle values", () => {
    const values = draws();
    expect(Math.min(...values)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...values)).toBeLessThanOrEqual(100);
    expect(values.every(Number.isInteger)).toBe(true);

    const share = (from: number, to: number) =>
      values.filter((value) => value >= from && value <= to).length / values.length;
    // Between 40 and 70 is the most frequent band; 80 and above is rare (about 8%).
    expect(share(40, 70)).toBeGreaterThan(0.55);
    expect(share(80, 100)).toBeGreaterThan(0.05);
    expect(share(80, 100)).toBeLessThan(0.11);
    expect(share(10, 39)).toBeLessThan(share(40, 70));
  });

  it("follows the configured range and shape", () => {
    const values = draws({
      ...DEFAULT_MATCH_RULES,
      hiddenMin: 1,
      hiddenMax: 5,
      hiddenMean: 3,
      hiddenSd: 1,
    });
    expect(new Set(values)).toEqual(new Set([1, 2, 3, 4, 5]));
    // A mean outside the range still yields values inside it.
    const off = draws(
      { ...DEFAULT_MATCH_RULES, hiddenMin: 10, hiddenMax: 20, hiddenMean: 500, hiddenSd: 1 },
      50,
    );
    expect(off.every((value) => value >= 10 && value <= 20)).toBe(true);
  });
});

describe("empire catalogue", () => {
  it("offers at least a hundred distinct colours", () => {
    expect(new Set(EMPIRE_COLORS).size).toBe(EMPIRE_COLORS.length);
    expect(MAX_PLAYERS_LIMIT).toBeGreaterThanOrEqual(100);
    expect(EMPIRE_COLORS.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
  });
});

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("matches", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  let areaId: string;
  let unitIds: number[];
  const cookies: Record<string, string> = {};

  beforeEach(async () => {
    await prisma.job.deleteMany();
    await prisma.match.deleteMany();
    await prisma.geoArea.deleteMany();
    await prisma.user.deleteMany();
    app = await buildApp({
      prisma,
      auth: { registerRateLimit: { max: 1000, windowMs: 60_000 } },
      logger: process.env.TEST_LOG ? { level: "error" } : false,
      health: {
        pingDatabase: () => Promise.resolve(),
        lastJobsPongAt: () => null,
        battleQueueConnected: () => true,
      },
    });

    // Six square municipalities in a row.
    const area = await prisma.geoArea.create({ data: { name: "Provincia" } });
    areaId = area.id;
    const upload = await prisma.geoUpload.create({
      data: { areaId, filename: "f", format: "GEOJSON", storagePath: "f" },
    });
    unitIds = [];
    for (let i = 0; i < 6; i++) {
      const lon = 9 + i * 0.1;
      const wkt = `POLYGON((${lon} 45,${lon + 0.1} 45,${lon + 0.1} 45.1,${lon} 45.1,${lon} 45))`;
      const rows = await prisma.$queryRaw<{ id: number }[]>`
        INSERT INTO "GeoUnit" ("areaId", "uploadId", name, "centroidLon", "centroidLat", "areaKm2", geom, "geomSimple")
        VALUES (${areaId}, ${upload.id}, ${`Comune ${i + 1}`}, ${lon + 0.05}, 45.05, 80,
          ST_Multi(ST_GeomFromText(${wkt}, 4326)), ST_Multi(ST_GeomFromText(${wkt}, 4326)))
        RETURNING id`;
      unitIds.push(rows[0]?.id ?? 0);
    }
    for (const name of ["anna", "bruno", "carla"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username: name, email: `${name}@example.test`, password: "password-123" },
      });
      cookies[name] = `sid=${response.cookies.find((c) => c.name === "sid")?.value ?? ""}`;
    }
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const as = (
    user: string | null,
    method: InjectOptions["method"],
    route: string,
    payload?: InjectOptions["payload"],
  ) =>
    app.inject({
      method,
      url: route,
      payload,
      headers: user ? { cookie: cookies[user] ?? "" } : {},
    });

  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();
  const empire = (name: string, color = EMPIRE_COLORS[0], emblem = EMPIRE_EMBLEMS[0]) => ({
    name,
    color,
    emblem,
    motto: null,
  });

  async function draft(overrides: object = {}) {
    const response = await as("anna", "POST", "/api/matches", {
      name: "Prima partita",
      areaIds: [areaId],
      startAt: tomorrow(),
      ...overrides,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }
  async function openMatch(overrides: object = {}) {
    const id = await draft(overrides);
    const response = await as("anna", "POST", `/api/matches/${id}/open`);
    expect(response.statusCode, response.body).toBe(200);
    return id;
  }
  const join = (user: string, id: string, unit: number, body: object) =>
    as(user, "POST", `/api/matches/${id}/join`, { geoUnitId: unit, ...body });

  describe("creation", () => {
    it("needs a session", async () => {
      const response = await as(null, "POST", "/api/matches", { name: "X" });
      expect(response.statusCode).toBe(401);
    });

    it("creates a draft with the defaults and stores every rule", async () => {
      const id = await draft({ config: { annexCost: 80 } });
      const match = (await as("anna", "GET", `/api/matches/${id}`)).json<{
        config: Record<string, unknown>;
      }>();
      expect(match).toMatchObject({
        status: "DRAFT",
        maxPlayers: 100,
        turnHours: 24,
        maxDays: null,
        players: 0,
        owner: "anna",
        isOwner: true,
        hasInviteCode: false,
      });
      expect(match.config).toEqual({ ...DEFAULT_MATCH_RULES, annexCost: 80 });
      // Nothing is created for a draft: no territories yet.
      expect(await prisma.territory.count()).toBe(0);
    });

    it("validates the settings", async () => {
      const base = { name: "Prima partita", areaIds: [areaId], startAt: tomorrow() };
      const invalid = [
        { ...base, name: "ab" },
        { ...base, areaIds: [] },
        { ...base, maxPlayers: 1 },
        { ...base, maxPlayers: MAX_PLAYERS_LIMIT + 1 },
        { ...base, turnHours: 0 },
        { ...base, config: { attackPct: 150 } },
        { ...base, config: { unknownRule: 1 } },
        { ...base, config: { hiddenMin: 90, hiddenMax: 20 } },
      ];
      for (const body of invalid) {
        const response = await as("anna", "POST", "/api/matches", body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
      }
      const unknownArea = await as("anna", "POST", "/api/matches", { ...base, areaIds: ["nope"] });
      expect(unknownArea.statusCode).toBe(404);
    });

    it("keeps a draft invisible to everyone but its owner", async () => {
      const id = await draft();
      expect((await as("bruno", "GET", `/api/matches/${id}`)).statusCode).toBe(404);
      expect((await as(null, "GET", `/api/matches/${id}/state`)).statusCode).toBe(404);
      expect((await as(null, "GET", "/api/matches")).json()).toMatchObject({ total: 0 });
      expect((await as("anna", "GET", "/api/matches/mine")).json<unknown[]>()).toHaveLength(1);
    });

    it("lets only the owner change or delete a draft", async () => {
      const id = await draft();
      expect((await as("bruno", "PATCH", `/api/matches/${id}`, { name: "Mia" })).statusCode).toBe(
        404,
      );
      const changed = await as("anna", "PATCH", `/api/matches/${id}`, {
        name: "Rinominata",
        turnHours: 12,
        config: { incomeBase: 70 },
      });
      expect(changed.json()).toMatchObject({ name: "Rinominata", turnHours: 12 });
      expect(
        changed.json<{ config: { incomeBase: number; annexCost: number } }>().config,
      ).toMatchObject({ incomeBase: 70, annexCost: 50 });
      expect((await as("anna", "DELETE", `/api/matches/${id}`)).statusCode).toBe(204);
      expect(await prisma.match.count()).toBe(0);
    });
  });

  describe("opening registrations", () => {
    it("creates a territory per municipality with hidden resources and schedules the start", async () => {
      const startAt = tomorrow();
      const id = await openMatch({ startAt });

      const territories = await prisma.territory.findMany({ include: { units: true } });
      expect(territories).toHaveLength(6);
      for (const territory of territories) {
        // The game territory is distinct from the municipality and holds exactly one for now.
        expect(territory.units).toHaveLength(1);
        expect(territory.ownerEmpireId).toBeNull();
        expect(territory.resources).toBeGreaterThanOrEqual(10);
        expect(territory.resources).toBeLessThanOrEqual(100);
      }
      expect(new Set(territories.map((t) => t.units[0]?.geoUnitId))).toEqual(new Set(unitIds));

      const jobs = await prisma.job.findMany({ where: { type: "match.start" } });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ payload: { matchId: id } });
      expect(jobs[0]?.runAt.toISOString()).toBe(startAt);
    });

    it("never sends the hidden resources of free municipalities to anyone", async () => {
      const id = await openMatch();
      for (const user of ["anna", "bruno", null]) {
        const state = await as(user, "GET", `/api/matches/${id}/state`);
        expect(state.json()).toMatchObject({ territories: [], empires: [], me: null });
        expect(state.body).not.toContain("resources");
      }
    });

    it("refuses a start in the past and a second opening", async () => {
      const past = await draft({ startAt: new Date(Date.now() - 1000).toISOString() });
      const response = await as("anna", "POST", `/api/matches/${past}/open`);
      expect(response.json()).toMatchObject({ error: { code: "START_IN_PAST" } });

      const id = await openMatch();
      expect((await as("anna", "POST", `/api/matches/${id}/open`)).statusCode).toBe(409);
      expect(await prisma.territory.count({ where: { matchId: id } })).toBe(6);
    });

    it("locks rules and map once open, but lets the date move and reschedules the start", async () => {
      const id = await openMatch();
      for (const body of [{ config: { annexCost: 1 } }, { areaIds: [areaId] }, { turnHours: 1 }]) {
        const response = await as("anna", "PATCH", `/api/matches/${id}`, body);
        expect(response.json()).toMatchObject({ error: { code: "MATCH_LOCKED" } });
      }
      const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const moved = await as("anna", "PATCH", `/api/matches/${id}`, { startAt: later });
      expect(moved.statusCode).toBe(200);
      const jobs = await prisma.job.findMany({
        where: { type: "match.start" },
        orderBy: { runAt: "asc" },
      });
      expect(jobs.map((job) => job.runAt.toISOString()).at(-1)).toBe(later);
      expect((await as("anna", "DELETE", `/api/matches/${id}`)).statusCode).toBe(409);
    });

    it("lists open matches with filters and pages", async () => {
      await openMatch({ name: "Lombardia" });
      const small = await openMatch({ name: "Brianza", maxPlayers: 2 });
      await join("anna", small, unitIds[0] ?? 0, { empire: empire("Uno") });
      await join("bruno", small, unitIds[1] ?? 0, { empire: empire("Due", EMPIRE_COLORS[1]) });

      const list = async (query: string) =>
        (await as(null, "GET", `/api/matches?${query}`)).json<{
          total: number;
          matches: { name: string; players: number }[];
        }>();
      expect((await list("")).total).toBe(2);
      expect((await list("name=brian")).matches.map((m) => m.name)).toEqual(["Brianza"]);
      expect((await list("size=free")).matches.map((m) => m.name)).toEqual(["Lombardia"]);
      expect((await list("size=s")).total).toBe(2);
      expect((await list("size=l")).total).toBe(0);
      const page = await list("pageSize=1&page=2");
      expect(page.total).toBe(2);
      expect(page.matches).toHaveLength(1);
      // The invite code never appears in a public list.
      expect(JSON.stringify(await list(""))).not.toContain('inviteCode":');
    });
  });

  describe("joining", () => {
    it("founds an empire: the municipality becomes a protected capital with the starting resources", async () => {
      const id = await openMatch();
      const hidden = (
        await prisma.territoryUnit.findFirstOrThrow({
          where: { matchId: id, geoUnitId: unitIds[2] },
          include: { territory: true },
        })
      ).territory.resources;

      const response = await join("bruno", id, unitIds[2] ?? 0, {
        empire: {
          name: "Ducato del Ticino",
          color: EMPIRE_COLORS[3],
          emblem: "torre",
          motto: "Di qua non si passa",
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      const state = response.json<{
        me: { empireId: string };
        empires: { id: string; capitalTerritoryId: string; units: number }[];
        territories: { id: string; resources: number; protected: boolean; geoUnitIds: number[] }[];
      }>();

      expect(state.empires).toMatchObject([
        {
          name: "Ducato del Ticino",
          emblem: "torre",
          username: "bruno",
          status: "ACTIVE",
          units: 1,
        },
      ]);
      expect(state.me.empireId).toBe(state.empires[0]?.id);
      // The hidden endowment of the capital is added to the starting resources (200 by default).
      expect(state.territories).toMatchObject([
        { geoUnitIds: [unitIds[2]], resources: hidden + 200, protected: true },
      ]);
      expect(state.empires[0]?.capitalTerritoryId).toBe(state.territories[0]?.id);

      const events = await prisma.gameEvent.findMany({ where: { type: "EMPIRE_CREATED" } });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]?.data)).not.toMatch(/\d{2,}/); // no amounts in events
    });

    it("shows other players the empire but never its resources", async () => {
      const id = await openMatch();
      await join("bruno", id, unitIds[0] ?? 0, { empire: empire("Bruno") });
      for (const user of ["anna", null]) {
        const state = (await as(user, "GET", `/api/matches/${id}/state`)).json<{
          me: unknown;
          territories: { resources: unknown }[];
        }>();
        expect(state.me).toBeNull();
        expect(state.territories).toHaveLength(1);
        expect(state.territories[0]?.resources).toBeNull();
      }
    });

    it("gives a contested municipality to whoever arrives first", async () => {
      const id = await openMatch();
      const target = unitIds[0] ?? 0;
      const [first, second] = await Promise.all([
        join("anna", id, target, { empire: empire("Anna", EMPIRE_COLORS[0]) }),
        join("bruno", id, target, { empire: empire("Bruno", EMPIRE_COLORS[1]) }),
      ]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
      const loser = first.statusCode === 409 ? first : second;
      expect(loser.json()).toMatchObject({ error: { code: "TERRITORY_TAKEN" } });
      // The loser has no empire left behind and can choose again.
      expect(await prisma.empire.count()).toBe(1);
      const retry = await join(first.statusCode === 409 ? "anna" : "bruno", id, unitIds[1] ?? 0, {
        empire: empire("Secondo", EMPIRE_COLORS[2]),
      });
      expect(retry.statusCode).toBe(201);
    });

    it("keeps names and colours unique in the match, and one empire per player", async () => {
      const id = await openMatch();
      await join("anna", id, unitIds[0] ?? 0, { empire: empire("Regno", EMPIRE_COLORS[0]) });

      const sameName = await join("bruno", id, unitIds[1] ?? 0, {
        empire: empire("regno", EMPIRE_COLORS[1]),
      });
      expect(sameName.json()).toMatchObject({ error: { code: "EMPIRE_NAME_TAKEN" } });
      const sameColor = await join("bruno", id, unitIds[1] ?? 0, {
        empire: empire("Altro", EMPIRE_COLORS[0]),
      });
      expect(sameColor.json()).toMatchObject({ error: { code: "EMPIRE_COLOR_TAKEN" } });
      const again = await join("anna", id, unitIds[1] ?? 0, {
        empire: empire("Bis", EMPIRE_COLORS[1]),
      });
      expect(again.json()).toMatchObject({ error: { code: "ALREADY_JOINED" } });
      // The same emblem can be shared: colour plus emblem tells empires apart.
      const sameEmblem = await join("bruno", id, unitIds[1] ?? 0, {
        empire: empire("Altro", EMPIRE_COLORS[1]),
      });
      expect(sameEmblem.statusCode).toBe(201);
    });

    it("rejects colours and emblems outside the catalogue", async () => {
      const id = await openMatch();
      const badColor = await join("anna", id, unitIds[0] ?? 0, { empire: empire("A", "#123456") });
      const badEmblem = await join("anna", id, unitIds[0] ?? 0, {
        empire: { ...empire("Anna"), emblem: "drago" },
      });
      expect(badColor.statusCode).toBe(400);
      expect(badEmblem.statusCode).toBe(400);
    });

    it("stops at the maximum number of players", async () => {
      const id = await openMatch({ maxPlayers: 2 });
      await join("anna", id, unitIds[0] ?? 0, { empire: empire("Uno", EMPIRE_COLORS[0]) });
      await join("bruno", id, unitIds[1] ?? 0, { empire: empire("Due", EMPIRE_COLORS[1]) });
      const third = await join("carla", id, unitIds[2] ?? 0, {
        empire: empire("Tre", EMPIRE_COLORS[2]),
      });
      expect(third.json()).toMatchObject({ error: { code: "MATCH_FULL" } });
    });

    it("asks for the invite code when the match has one, and shows it only to the owner", async () => {
      const id = await openMatch({ inviteCode: "segreto" });
      expect((await as("anna", "GET", `/api/matches/${id}`)).json()).toMatchObject({
        inviteCode: "segreto",
      });
      const seen = await as("bruno", "GET", `/api/matches/${id}`);
      expect(seen.json()).toMatchObject({ hasInviteCode: true });
      expect(seen.body).not.toContain("segreto");

      const without = await join("bruno", id, unitIds[0] ?? 0, { empire: empire("Bruno") });
      expect(without.statusCode).toBe(403);
      const wrong = await join("bruno", id, unitIds[0] ?? 0, {
        empire: empire("Bruno"),
        inviteCode: "x",
      });
      expect(wrong.json()).toMatchObject({ error: { code: "INVITE_CODE_REQUIRED" } });
      const right = await join("bruno", id, unitIds[0] ?? 0, {
        empire: empire("Bruno"),
        inviteCode: "segreto",
      });
      expect(right.statusCode).toBe(201);
    });

    it("refuses guests, drafts and municipalities outside the match", async () => {
      const id = await openMatch();
      expect((await join("", id, unitIds[0] ?? 0, { empire: empire("Nessuno") })).statusCode).toBe(
        401,
      );
      const outside = await join("anna", id, 999_999, { empire: empire("Anna") });
      expect(outside.statusCode).toBe(404);
      const hidden = await draft();
      expect(
        (await join("bruno", hidden, unitIds[0] ?? 0, { empire: empire("Bruno") })).statusCode,
      ).toBe(404);
    });

    it("lets a player withdraw before the start: the municipality is free again, with a new endowment", async () => {
      const id = await openMatch();
      await join("anna", id, unitIds[0] ?? 0, { empire: empire("Anna", EMPIRE_COLORS[0]) });
      await join("bruno", id, unitIds[1] ?? 0, { empire: empire("Bruno", EMPIRE_COLORS[1]) });
      const territory = async () =>
        (
          await prisma.territoryUnit.findFirstOrThrow({
            where: { matchId: id, geoUnitId: unitIds[0] },
            include: { territory: true },
          })
        ).territory;
      expect((await territory()).resources).toBeGreaterThanOrEqual(
        DEFAULT_MATCH_RULES.startResources,
      );

      expect((await as(null, "DELETE", `/api/matches/${id}/empire`)).statusCode).toBe(401);
      expect((await as("carla", "DELETE", `/api/matches/${id}/empire`)).json()).toMatchObject({
        error: { code: "NOT_A_PLAYER" },
      });
      const response = await as("anna", "DELETE", `/api/matches/${id}/empire`);
      expect(response.statusCode, response.body).toBe(200);
      const after = response.json<{ me: unknown; empires: { name: string }[] }>();
      expect(after.me).toBeNull();
      expect(after.empires.map((e) => e.name)).toEqual(["Bruno"]);

      // Free again, unprotected, and holding a hidden endowment as before anyone came:
      // not the starting resources of the empire that left.
      const freed = await territory();
      expect(freed).toMatchObject({ ownerEmpireId: null, protectedUntilTurn: null });
      expect(freed.resources).toBeLessThan(DEFAULT_MATCH_RULES.startResources);
      const event = await prisma.gameEvent.findFirstOrThrow({
        where: { type: "EMPIRE_WITHDRAWN" },
      });
      expect(event.data).toEqual({ empireName: "Anna", territoryName: freed.name });

      // The same player can come back, there or elsewhere, and so can anyone else.
      const again = await join("anna", id, unitIds[2] ?? 0, {
        empire: empire("Anna", EMPIRE_COLORS[0]),
      });
      expect(again.statusCode, again.body).toBe(201);
      expect(
        (await join("carla", id, unitIds[0] ?? 0, { empire: empire("Carla", EMPIRE_COLORS[2]) }))
          .statusCode,
      ).toBe(201);

      // Once the match runs, nobody walks away.
      await prisma.match.update({ where: { id }, data: { status: "RUNNING", currentTurn: 1 } });
      expect((await as("bruno", "DELETE", `/api/matches/${id}/empire`)).json()).toMatchObject({
        error: { code: "MATCH_STARTED" },
      });
    });

    it("lets a player restyle the empire before the start, not after", async () => {
      const id = await openMatch();
      await join("anna", id, unitIds[0] ?? 0, { empire: empire("Anna", EMPIRE_COLORS[0]) });
      await join("bruno", id, unitIds[1] ?? 0, { empire: empire("Bruno", EMPIRE_COLORS[1]) });

      const restyled = await as("anna", "PATCH", `/api/matches/${id}/empire`, {
        name: "Signoria di Anna",
        color: EMPIRE_COLORS[5],
        emblem: "luna",
        motto: "Sempre avanti",
      });
      expect(restyled.statusCode, restyled.body).toBe(200);
      expect(restyled.json<{ empires: object[] }>().empires[0]).toMatchObject({
        name: "Signoria di Anna",
        emblem: "luna",
        motto: "Sempre avanti",
      });
      const taken = await as(
        "anna",
        "PATCH",
        `/api/matches/${id}/empire`,
        empire("Bruno", EMPIRE_COLORS[5]),
      );
      expect(taken.json()).toMatchObject({ error: { code: "EMPIRE_NAME_TAKEN" } });

      await prisma.match.update({ where: { id }, data: { status: "RUNNING", currentTurn: 1 } });
      const late = await as(
        "anna",
        "PATCH",
        `/api/matches/${id}/empire`,
        empire("Tardi", EMPIRE_COLORS[6]),
      );
      expect(late.json()).toMatchObject({ error: { code: "MATCH_STARTED" } });
    });

    it("accepts late players in a running match only when the rules allow it", async () => {
      const open = await openMatch();
      await prisma.match.update({
        where: { id: open },
        data: { status: "RUNNING", currentTurn: 4 },
      });
      const late = await join("bruno", open, unitIds[0] ?? 0, { empire: empire("Bruno") });
      expect(late.statusCode).toBe(201);
      // Acquired during turn 4: protected until that turn ends.
      const capital = await prisma.territory.findFirstOrThrow({
        where: { ownerEmpireId: { not: null } },
      });
      expect(capital.protectedUntilTurn).toBe(4);

      const closed = await openMatch({ config: { lateJoin: false } });
      await prisma.match.update({
        where: { id: closed },
        data: { status: "RUNNING", currentTurn: 1 },
      });
      const refused = await join("carla", closed, unitIds[0] ?? 0, { empire: empire("Carla") });
      expect(refused.json()).toMatchObject({ error: { code: "REGISTRATION_CLOSED" } });
    });
  });

  describe("map of a match", () => {
    it("describes the extent and serves immutable tiles of its municipalities", async () => {
      const id = await openMatch();
      const map = (await as(null, "GET", `/api/matches/${id}/map`)).json<{
        bounds: number[];
        tiles: string;
        unitCount: number;
      }>();
      expect(map.unitCount).toBe(6);
      expect(map.bounds.map((n) => Math.round(n * 10) / 10)).toEqual([9, 45, 9.6, 45.1]);
      expect(map.tiles).toBe(`/api/matches/${id}/tiles/{z}/{x}/{y}.mvt?v=6`);

      const tile = await as(null, "GET", `/api/matches/${id}/tiles/9/268/183.mvt?v=6`);
      expect(tile.statusCode).toBe(200);
      expect(tile.headers["cache-control"]).toContain("immutable");
      expect(tile.rawPayload.toString("latin1")).toContain("Comune 1");

      const units = (await as(null, "GET", `/api/matches/${id}/units`)).json<unknown[]>();
      expect(units).toHaveLength(6);
    });

    it("has no map for a draft", async () => {
      const id = await draft();
      expect((await as(null, "GET", `/api/matches/${id}/map`)).statusCode).toBe(404);
      expect((await as(null, "GET", `/api/matches/${id}/tiles/9/268/183.mvt`)).statusCode).toBe(
        404,
      );
    });
  });

  it("offers the defaults, the limits and the empire catalogue to the forms", async () => {
    const options = (await as(null, "GET", "/api/matches/options")).json<unknown>();
    expect(options).toMatchObject({
      rules: DEFAULT_MATCH_RULES,
      maxPlayersLimit: MAX_PLAYERS_LIMIT,
      emblems: [...EMPIRE_EMBLEMS],
    });
  });

  it("lists the folder tree with the municipalities under each node", async () => {
    const child = await prisma.geoArea.create({ data: { name: "Vuota", parentId: areaId } });
    const tree = (await as(null, "GET", "/api/geo/tree")).json<
      { id: string; unitCount: number }[]
    >();
    expect(tree.find((node) => node.id === areaId)).toMatchObject({ unitCount: 6, parentId: null });
    expect(tree.find((node) => node.id === child.id)).toMatchObject({
      unitCount: 0,
      parentId: areaId,
    });
  });
});
