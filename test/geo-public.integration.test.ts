import { gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrisma } from "../src/db/prisma.js";
import { TileCache } from "../src/modules/geo/tile-cache.js";

describe("tile cache", () => {
  it("evicts the least recently used tiles when it is full", () => {
    const cache = new TileCache(10);
    cache.set("a", Buffer.alloc(4));
    cache.set("b", Buffer.alloc(4));
    expect(cache.get("a")).toBeDefined(); // a is now the most recent
    cache.set("c", Buffer.alloc(4));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("replaces a key without counting it twice and skips oversized tiles", () => {
    const cache = new TileCache(10);
    cache.set("a", Buffer.alloc(6));
    cache.set("a", Buffer.alloc(6));
    cache.set("b", Buffer.alloc(4));
    expect(cache.size).toBe(2);
    cache.set("huge", Buffer.alloc(11));
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.size).toBe(2);
  });
});

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("public geography", () => {
  const prisma = createPrisma(url ?? "");
  let app: FastifyInstance;

  beforeEach(async () => {
    await prisma.match.deleteMany();
    await prisma.geoArea.deleteMany();
    app = await buildApp({
      prisma,
      health: {
        pingDatabase: () => Promise.resolve(),
        lastJobsPongAt: () => null,
        battleQueueConnected: () => true,
      },
    });
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A square municipality with its corner at (lon, lat), a tenth of a degree wide. */
  async function unit(areaId: string, uploadId: string, name: string, lon: number, lat: number) {
    const wkt = `POLYGON((${lon} ${lat},${lon + 0.1} ${lat},${lon + 0.1} ${lat + 0.1},${lon} ${lat + 0.1},${lon} ${lat}))`;
    const rows = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "GeoUnit" ("areaId", "uploadId", name, "centroidLon", "centroidLat", "areaKm2", geom, "geomSimple")
      VALUES (${areaId}, ${uploadId}, ${name}, ${lon + 0.05}, ${lat + 0.05}, 80,
        ST_Multi(ST_GeomFromText(${wkt}, 4326)), ST_Multi(ST_GeomFromText(${wkt}, 4326)))
      RETURNING id`;
    return rows[0]?.id ?? 0;
  }

  async function seed() {
    const italy = await prisma.geoArea.create({ data: { name: "Italia" } });
    const north = await prisma.geoArea.create({ data: { name: "Nord", parentId: italy.id } });
    const empty = await prisma.geoArea.create({ data: { name: "Vuota" } });
    const upload = await prisma.geoUpload.create({
      data: { areaId: north.id, filename: "f", format: "GEOJSON", storagePath: "f" },
    });
    const milano = await unit(north.id, upload.id, "Milano", 9.1, 45.4);
    const monza = await unit(north.id, upload.id, "Monza", 9.2, 45.5);
    return { italy: italy.id, north: north.id, empty: empty.id, upload: upload.id, milano, monza };
  }

  // The tile of zoom 9 that contains Milan.
  const milanTile = "9/269/183";

  it("lists the areas that have municipalities, without a session", async () => {
    const { italy } = await seed();
    const response = await app.inject("/api/geo/areas");
    expect(response.statusCode).toBe(200);
    // The count includes the folders below; the empty area is left out.
    expect(response.json()).toEqual([{ id: italy, name: "Italia", unitCount: 2 }]);
  });

  it("describes the map of a folder: extent, version and tile address", async () => {
    const { italy, empty } = await seed();
    const map = (await app.inject(`/api/geo/areas/${italy}/map`)).json<{
      bounds: number[];
      tiles: string;
      version: string;
    }>();
    expect(map).toMatchObject({ name: "Italia", unitCount: 2, minZoom: 4, maxZoom: 12 });
    expect(map.bounds.map((n) => Math.round(n * 10) / 10)).toEqual([9.1, 45.4, 9.3, 45.6]);
    expect(map.tiles).toBe(`/api/geo/areas/${italy}/tiles/{z}/{x}/{y}.mvt?v=${map.version}`);

    expect((await app.inject(`/api/geo/areas/${empty}/map`)).json()).toMatchObject({
      unitCount: 0,
      bounds: null,
    });
    expect((await app.inject("/api/geo/areas/nope/map")).statusCode).toBe(404);
  });

  it("lists the municipalities with a point inside each", async () => {
    const { italy, milano } = await seed();
    const response = await app.inject(`/api/geo/areas/${italy}/units`);
    expect(response.json<unknown[]>()).toHaveLength(2);
    expect(response.json<unknown[]>()[0]).toEqual({
      id: milano,
      name: "Milano",
      lon: 9.15,
      lat: 45.45,
    });
  });

  it("serves vector tiles that can be cached forever under their version", async () => {
    const { italy } = await seed();
    const { version } = (await app.inject(`/api/geo/areas/${italy}/map`)).json<{
      version: string;
    }>();

    const tile = await app.inject(`/api/geo/areas/${italy}/tiles/${milanTile}.mvt?v=${version}`);
    expect(tile.statusCode).toBe(200);
    expect(tile.headers["content-type"]).toBe("application/vnd.mapbox-vector-tile");
    expect(tile.headers["cache-control"]).toContain("immutable");
    // Layer and property names are plain text inside the protobuf.
    const body = tile.rawPayload.toString("latin1");
    for (const text of ["units", "labels", "Milano", "name"]) expect(body).toContain(text);
    expect(() => gunzipSync(tile.rawPayload)).toThrow(); // compression is left to the proxy

    // A tile far away is empty; one requested without the current version is not cacheable.
    const far = await app.inject(`/api/geo/areas/${italy}/tiles/9/0/0.mvt?v=${version}`);
    expect(far.rawPayload).toHaveLength(0);
    const stale = await app.inject(`/api/geo/areas/${italy}/tiles/${milanTile}.mvt?v=old`);
    expect(stale.headers["cache-control"]).toBe("no-cache");
  });

  it("leaves names out of the tiles at low zoom", async () => {
    const { italy } = await seed();
    const tile = await app.inject(`/api/geo/areas/${italy}/tiles/6/33/22.mvt`);
    const body = tile.rawPayload.toString("latin1");
    expect(body).toContain("units");
    expect(body).not.toContain("labels");
  });

  it("changes version, and so tile addresses, when the municipalities change", async () => {
    const { italy, north, upload } = await seed();
    const before = (await app.inject(`/api/geo/areas/${italy}/map`)).json<{ version: string }>();
    await unit(north, upload, "Lodi", 9.4, 45.3);
    const after = (await app.inject(`/api/geo/areas/${italy}/map`)).json<{ version: string }>();
    expect(after.version).not.toBe(before.version);

    const tile = await app.inject(`/api/geo/areas/${italy}/tiles/8/134/91.mvt?v=${after.version}`);
    expect(tile.rawPayload.toString("latin1")).toContain("Lodi");
  });

  it("rejects tiles outside the grid or the zoom range", async () => {
    const { italy } = await seed();
    for (const tile of ["9/999/0", "3/4/2", "13/0/0", "9/a/b"]) {
      const response = await app.inject(`/api/geo/areas/${italy}/tiles/${tile}.mvt`);
      expect(response.statusCode, tile).toBe(400);
    }
  });
});

describe("tile cache under a rush", () => {
  it("generates a tile once however many ask for it at the same moment", async () => {
    const cache = new TileCache(1000);
    let generated = 0;
    const generate = async () => {
      generated += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Buffer.from("tile");
    };
    const tiles = await Promise.all(Array.from({ length: 50 }, () => cache.load("k", generate)));
    expect(generated).toBe(1);
    expect(new Set(tiles.map((tile) => tile.toString()))).toEqual(new Set(["tile"]));
    // Afterwards it comes from the cache.
    await cache.load("k", generate);
    expect(generated).toBe(1);
  });

  it("does not keep a failure: the next request tries again", async () => {
    const cache = new TileCache(1000);
    await expect(cache.load("k", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect((await cache.load("k", () => Promise.resolve(Buffer.from("ok")))).toString()).toBe("ok");
  });
});
