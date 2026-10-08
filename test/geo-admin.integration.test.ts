import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { contentMatchesFormat, formatFromFilename } from "../src/modules/geo/files.js";
import { DEFAULT_MATCH_RULES } from "../src/rules/config.js";
import { seedAdmin } from "../src/seed/admin.js";

describe("geo file checks", () => {
  it("accepts only kml, json and geojson names", () => {
    expect(formatFromFilename("comuni.KML")).toBe("KML");
    expect(formatFromFilename("comuni.geojson")).toBe("GEOJSON");
    expect(formatFromFilename("comuni.json")).toBe("GEOJSON");
    expect(formatFromFilename("comuni.shp")).toBeNull();
    expect(formatFromFilename("comuni")).toBeNull();
  });

  it("compares the first bytes with the announced format", () => {
    expect(contentMatchesFormat(Buffer.from('\n  {"type":"FeatureCollection"'), "GEOJSON")).toBe(
      true,
    );
    expect(contentMatchesFormat(Buffer.from("﻿<?xml version"), "KML")).toBe(true);
    expect(contentMatchesFormat(Buffer.from("<kml>"), "GEOJSON")).toBe(false);
    expect(contentMatchesFormat(Buffer.from("PK\u0003\u0004"), "KML")).toBe(false);
  });
});

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("geo administration", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;
  let uploadDir: string;
  let admin: string;

  beforeEach(async () => {
    await prisma.job.deleteMany();
    await prisma.match.deleteMany();
    await prisma.geoArea.deleteMany();
    await prisma.user.deleteMany();
    uploadDir = await mkdtemp(path.join(tmpdir(), "looters-uploads-"));
    app = await buildApp({
      prisma,
      uploads: { dir: uploadDir, maxMegabytes: 1 },
      health: {
        pingDatabase: () => Promise.resolve(),
        lastJobsPongAt: () => null,
        battleQueueConnected: () => true,
      },
    });
    await seedAdmin(prisma, {
      username: "admin",
      email: "a@example.test",
      password: "x".repeat(12),
    });
    admin = await login({ username: "admin", password: "x".repeat(12) });
  });
  afterEach(async () => {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function login(payload: InjectOptions["payload"], route = "/api/auth/login") {
    const response = await app.inject({ method: "POST", url: route, payload });
    return `sid=${response.cookies.find((c) => c.name === "sid")?.value ?? ""}`;
  }

  const call = (
    method: InjectOptions["method"],
    route: string,
    payload?: InjectOptions["payload"],
  ) => app.inject({ method, url: route, payload, headers: { cookie: admin } });

  async function createArea(name: string, parentId?: string) {
    const response = await call("POST", "/api/admin/geo/areas", { name, parentId });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** A multipart request carrying one file. */
  function upload(areaId: string, filename: string, content: string | Buffer) {
    const boundary = "----looters-test";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: "POST",
      url: `/api/admin/geo/areas/${areaId}/uploads`,
      payload: body,
      headers: { cookie: admin, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
  }

  /** Inserts a municipality directly, as `jobs` would after processing an upload. */
  async function insertUnit(areaId: string, uploadId: string, name: string): Promise<number> {
    const rows = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "GeoUnit" ("areaId", "uploadId", name, "centroidLon", "centroidLat", "areaKm2", geom, "geomSimple")
      VALUES (${areaId}, ${uploadId}, ${name}, 9, 45, 1,
        ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))', 4326)),
        ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))', 4326)))
      RETURNING id`;
    return rows[0]?.id ?? 0;
  }

  const geojson = '{"type":"FeatureCollection","features":[]}';

  it("is closed to guests and to normal users", async () => {
    const player = await login(
      { username: "mario", email: "m@example.test", password: "password-123" },
      "/api/auth/register",
    );
    for (const route of ["/api/admin/stats", "/api/admin/geo/areas", "/api/admin/geo/uploads"]) {
      expect((await app.inject({ url: route })).statusCode).toBe(401);
      expect((await app.inject({ url: route, headers: { cookie: player } })).statusCode).toBe(403);
    }
  });

  it("reports registered players and running matches", async () => {
    const owner = await prisma.user.create({
      data: { username: "mario", email: "m@example.test", passwordHash: "x" },
    });
    const match = { ownerId: owner.id, startAt: new Date(), config: DEFAULT_MATCH_RULES };
    await prisma.match.create({ data: { ...match, name: "Running", status: "RUNNING" } });
    await prisma.match.create({ data: { ...match, name: "Draft" } });

    // The admin is not a player: it is not counted among the registered users.
    expect((await call("GET", "/api/admin/stats")).json()).toEqual({
      users: 1,
      matchesRunning: 1,
      online: 0,
    });
  });

  describe("folders", () => {
    it("nests folders and counts the municipalities of the whole subtree", async () => {
      const italy = await createArea("Italia");
      const north = await createArea("Nord", italy);
      const lombardy = await createArea("Lombardia", north);
      const stored = await prisma.geoUpload.create({
        data: { areaId: lombardy, filename: "f.geojson", format: "GEOJSON", storagePath: "f" },
      });
      await insertUnit(lombardy, stored.id, "Milano");
      await insertUnit(lombardy, stored.id, "Monza");

      const areas = (await call("GET", "/api/admin/geo/areas")).json<
        { name: string; parentId: string | null; unitCount: number; uploadCount: number }[]
      >();
      const byName = Object.fromEntries(areas.map((area) => [area.name, area]));
      expect(byName.Italia).toMatchObject({ parentId: null, unitCount: 2, uploadCount: 0 });
      expect(byName.Nord).toMatchObject({ parentId: italy, unitCount: 2 });
      expect(byName.Lombardia).toMatchObject({ parentId: north, unitCount: 2, uploadCount: 1 });
    });

    it("refuses a duplicate name in the same folder but allows it elsewhere", async () => {
      const italy = await createArea("Italia");
      await createArea("Nord", italy);
      const clash = await call("POST", "/api/admin/geo/areas", { name: "nord", parentId: italy });
      expect(clash.statusCode).toBe(409);
      expect(clash.json()).toMatchObject({ error: { code: "AREA_NAME_TAKEN" } });
      await createArea("Nord", await createArea("Francia"));
    });

    it("renames a folder and rejects an unknown parent", async () => {
      const italy = await createArea("Itala");
      const renamed = await call("PATCH", `/api/admin/geo/areas/${italy}`, { name: "Italia" });
      expect(renamed.json()).toMatchObject({ name: "Italia" });
      const orphan = await call("POST", "/api/admin/geo/areas", { name: "X", parentId: "nope" });
      expect(orphan.statusCode).toBe(404);
    });

    it("deletes a folder with its contents and files, unless a match uses it", async () => {
      const italy = await createArea("Italia");
      const north = await createArea("Nord", italy);
      expect((await upload(north, "nord.geojson", geojson)).statusCode).toBe(201);
      expect(await readdir(uploadDir)).toHaveLength(1);

      const owner = await prisma.user.create({
        data: { username: "mario", email: "m@example.test", passwordHash: "x" },
      });
      const match = await prisma.match.create({
        data: {
          name: "Test",
          ownerId: owner.id,
          startAt: new Date(),
          config: DEFAULT_MATCH_RULES,
          areas: { create: { areaId: north } },
        },
      });
      const inUse = await call("DELETE", `/api/admin/geo/areas/${italy}`);
      expect(inUse.statusCode).toBe(409);
      expect(inUse.json()).toMatchObject({ error: { code: "AREA_IN_USE" } });

      await prisma.match.delete({ where: { id: match.id } });
      expect((await call("DELETE", `/api/admin/geo/areas/${italy}`)).statusCode).toBe(204);
      expect(await prisma.geoArea.count()).toBe(0);
      expect(await prisma.geoUpload.count()).toBe(0);
      expect(await readdir(uploadDir)).toHaveLength(0);
    });
  });

  describe("uploads", () => {
    it("stores the file, records the upload and queues its processing", async () => {
      const area = await createArea("Italia");
      const response = await upload(area, "Comuni Lombardia.GeoJSON", geojson);

      expect(response.statusCode, response.body).toBe(201);
      const created = response.json<{ id: string }>();
      expect(created).toMatchObject({
        areaId: area,
        filename: "Comuni Lombardia.GeoJSON",
        format: "GEOJSON",
        status: "PENDING",
        progress: 0,
        sizeBytes: geojson.length,
      });
      expect(await readdir(uploadDir)).toEqual([`${created.id}.geojson`]);

      const jobs = await prisma.job.findMany();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ type: "geo.process", payload: { uploadId: created.id } });

      const list = (await call("GET", `/api/admin/geo/uploads?areaId=${area}`)).json<unknown[]>();
      expect(list).toHaveLength(1);
      expect((await call("GET", `/api/admin/geo/uploads/${created.id}`)).json()).toMatchObject({
        id: created.id,
      });
    });

    it("accepts KML", async () => {
      const area = await createArea("Italia");
      const response = await upload(area, "comuni.kml", '<?xml version="1.0"?><kml></kml>');
      expect(response.json()).toMatchObject({ format: "KML" });
    });

    it("refuses other types, mismatched content and oversized files, leaving nothing behind", async () => {
      const area = await createArea("Italia");
      const cases: [string, string | Buffer, number, string][] = [
        ["comuni.shp", "x", 400, "UNSUPPORTED_FILE"],
        ["comuni.geojson", "<kml></kml>", 400, "UNSUPPORTED_FILE"],
        ["comuni.kml", geojson, 400, "UNSUPPORTED_FILE"],
        ["comuni.geojson", Buffer.alloc(1_100_000, "{"), 413, "FILE_TOO_LARGE"],
      ];
      for (const [filename, content, status, code] of cases) {
        const response = await upload(area, filename, content);
        expect(response.statusCode, filename).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
      }
      expect(await prisma.geoUpload.count()).toBe(0);
      expect(await prisma.job.count()).toBe(0);
      expect(await readdir(uploadDir)).toHaveLength(0);
    });

    it("refuses an upload to an unknown folder", async () => {
      expect((await upload("nope", "comuni.geojson", geojson)).statusCode).toBe(404);
    });

    it("deletes a finished upload but not one being processed", async () => {
      const area = await createArea("Italia");
      const { id } = (await upload(area, "comuni.geojson", geojson)).json<{ id: string }>();

      const busy = await call("DELETE", `/api/admin/geo/uploads/${id}`);
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ error: { code: "UPLOAD_IN_PROGRESS" } });

      await prisma.geoUpload.update({ where: { id }, data: { status: "DONE" } });
      await insertUnit(area, id, "Milano");
      expect((await call("DELETE", `/api/admin/geo/uploads/${id}`)).statusCode).toBe(204);
      expect(await prisma.geoUnit.count()).toBe(0);
      expect(await readdir(uploadDir)).toHaveLength(0);
    });
  });

  describe("adjacency", () => {
    async function units() {
      const area = await createArea("Italia");
      const stored = await prisma.geoUpload.create({
        data: { areaId: area, filename: "f.geojson", format: "GEOJSON", storagePath: "f" },
      });
      const [messina, villa, reggio] = await Promise.all(
        ["Messina", "Villa San Giovanni", "Reggio di Calabria"].map((name) =>
          insertUnit(area, stored.id, name),
        ),
      );
      return { messina: messina ?? 0, villa: villa ?? 0, reggio: reggio ?? 0 };
    }

    it("finds municipalities by name, names starting with the query first", async () => {
      await units();
      const found = (await call("GET", "/api/admin/geo/units?q=giov")).json<{ name: string }[]>();
      expect(found.map((unit) => unit.name)).toEqual(["Villa San Giovanni"]);
      const starting = (await call("GET", "/api/admin/geo/units?q=re")).json<{ name: string }[]>();
      expect(starting[0]?.name).toBe("Reggio di Calabria");
      expect((await call("GET", "/api/admin/geo/units?q=r")).statusCode).toBe(400);
    });

    it("adds a manual adjacency once, in either order, and lists it", async () => {
      const { messina, villa } = await units();
      const body = { aId: Math.max(messina, villa), bId: Math.min(messina, villa) };
      expect((await call("POST", "/api/admin/geo/adjacency", body)).statusCode).toBe(201);

      const again = await call("POST", "/api/admin/geo/adjacency", {
        aId: body.bId,
        bId: body.aId,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: { code: "ALREADY_ADJACENT" } });

      const stored = await prisma.geoAdjacency.findMany();
      expect(stored).toEqual([{ aId: body.bId, bId: body.aId, manual: true }]);

      const manual = (await call("GET", "/api/admin/geo/adjacency/manual")).json<unknown[]>();
      expect(manual).toHaveLength(1);
      const neighbours = (await call("GET", `/api/admin/geo/units/${messina}/neighbours`)).json<
        unknown[]
      >();
      expect(neighbours).toMatchObject([{ name: "Villa San Giovanni", manual: true }]);
    });

    it("rejects a municipality paired with itself or with an unknown one", async () => {
      const { messina } = await units();
      const self = await call("POST", "/api/admin/geo/adjacency", { aId: messina, bId: messina });
      expect(self.statusCode).toBe(400);
      const unknown = await call("POST", "/api/admin/geo/adjacency", {
        aId: messina,
        bId: 999_999,
      });
      expect(unknown.statusCode).toBe(404);
    });

    it("removes manual adjacencies only", async () => {
      const { messina, villa, reggio } = await units();
      await call("POST", "/api/admin/geo/adjacency", { aId: messina, bId: villa });
      const computed = { aId: Math.min(villa, reggio), bId: Math.max(villa, reggio) };
      await prisma.geoAdjacency.create({ data: computed });

      expect((await call("DELETE", "/api/admin/geo/adjacency", computed)).statusCode).toBe(404);
      expect(
        (await call("DELETE", "/api/admin/geo/adjacency", { aId: villa, bId: messina })).statusCode,
      ).toBe(204);
      expect(await prisma.geoAdjacency.findMany()).toEqual([{ ...computed, manual: false }]);
    });
  });
});
