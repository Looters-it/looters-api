import multipart from "@fastify/multipart";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthGuard } from "../../auth/guard.js";
import { AppError, notFound } from "../../http/errors.js";
import { enqueueJob } from "../../queue/jobs.js";
import { contentMatchesFormat, formatFromFilename, UploadStore } from "./files.js";

export interface GeoAdminDeps {
  prisma: PrismaClient;
  guard: AuthGuard;
  uploadDir: string;
  maxUploadBytes: number;
}

const idParams = z.object({ id: z.string().min(1) });
const unitParams = z.object({ id: z.coerce.number().int().positive() });
const areaName = z.string().trim().min(1).max(80);
const createAreaBody = z.strictObject({ name: areaName, parentId: z.string().min(1).optional() });
const renameAreaBody = z.strictObject({ name: areaName });
const uploadsQuery = z.object({ areaId: z.string().min(1).optional() });
const unitsQuery = z.object({
  q: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const pairBody = z
  .strictObject({ aId: z.number().int().positive(), bId: z.number().int().positive() })
  .refine((pair) => pair.aId !== pair.bId, "A unit cannot be adjacent to itself");

/** Adjacency is stored once per pair, smaller id first. */
const ordered = (pair: { aId: number; bId: number }) => ({
  aId: Math.min(pair.aId, pair.bId),
  bId: Math.max(pair.aId, pair.bId),
});

const isForeignKeyError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";

const uploadSelect = {
  id: true,
  areaId: true,
  filename: true,
  format: true,
  status: true,
  progress: true,
  unitCount: true,
  adjacencyCount: true,
  sizeBytes: true,
  error: true,
  createdAt: true,
  finishedAt: true,
} satisfies Prisma.GeoUploadSelect;

export async function registerGeoAdminRoutes(
  app: FastifyInstance,
  deps: GeoAdminDeps,
): Promise<void> {
  const { prisma, guard } = deps;
  const store = new UploadStore(deps.uploadDir);

  await app.register(multipart, {
    limits: { fileSize: deps.maxUploadBytes, files: 1, fields: 0 },
  });

  // ---------- Areas and folders ----------

  /** Flat list of the tree; `unitCount` includes every descendant. */
  app.get("/api/admin/geo/areas", async (request) => {
    await guard.admin(request);
    const [areas, counts] = await Promise.all([
      prisma.geoArea.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, parentId: true, _count: { select: { uploads: true } } },
      }),
      prisma.geoUnit.groupBy({ by: ["areaId"], _count: true }),
    ]);

    const own = new Map(counts.map((row) => [row.areaId, row._count]));
    const children = new Map<string | null, string[]>();
    for (const area of areas) {
      children.set(area.parentId, [...(children.get(area.parentId) ?? []), area.id]);
    }
    const total = (id: string): number =>
      (own.get(id) ?? 0) + (children.get(id) ?? []).reduce((sum, child) => sum + total(child), 0);

    return areas.map((area) => ({
      id: area.id,
      name: area.name,
      parentId: area.parentId,
      uploadCount: area._count.uploads,
      unitCount: total(area.id),
    }));
  });

  const assertNameFree = async (name: string, parentId: string | null, exceptId?: string) => {
    const clash = await prisma.geoArea.findFirst({
      where: { parentId, name: { equals: name, mode: "insensitive" }, NOT: { id: exceptId } },
    });
    if (clash)
      throw new AppError(409, "AREA_NAME_TAKEN", "A folder with this name already exists here");
  };

  app.post("/api/admin/geo/areas", async (request, reply) => {
    await guard.admin(request);
    const body = createAreaBody.parse(request.body);
    const parentId = body.parentId ?? null;
    if (parentId && !(await prisma.geoArea.findUnique({ where: { id: parentId } }))) {
      throw notFound("Parent folder");
    }
    await assertNameFree(body.name, parentId);
    const area = await prisma.geoArea.create({
      data: { name: body.name, parentId },
      select: { id: true, name: true, parentId: true },
    });
    return reply.code(201).send({ ...area, uploadCount: 0, unitCount: 0 });
  });

  app.patch("/api/admin/geo/areas/:id", async (request) => {
    await guard.admin(request);
    const { id } = idParams.parse(request.params);
    const body = renameAreaBody.parse(request.body);
    const area = await prisma.geoArea.findUnique({ where: { id } });
    if (!area) throw notFound("Folder");
    await assertNameFree(body.name, area.parentId, id);
    return prisma.geoArea.update({
      where: { id },
      data: { name: body.name },
      select: { id: true, name: true, parentId: true },
    });
  });

  /** Deletes the folder with everything inside it, unless a match uses any of it. */
  app.delete("/api/admin/geo/areas/:id", async (request, reply) => {
    await guard.admin(request);
    const { id } = idParams.parse(request.params);
    const files = await prisma.$queryRaw<{ storagePath: string }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM "GeoArea" WHERE id = ${id}
        UNION ALL
        SELECT child.id FROM "GeoArea" child JOIN tree ON child."parentId" = tree.id
      )
      SELECT "storagePath" FROM "GeoUpload" WHERE "areaId" IN (SELECT id FROM tree)`;
    try {
      await prisma.geoArea.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw notFound("Folder");
      }
      if (isForeignKeyError(error)) {
        throw new AppError(409, "AREA_IN_USE", "A match uses this folder: it cannot be deleted");
      }
      throw error;
    }
    await Promise.all(files.map((file) => store.remove(file.storagePath)));
    return reply.code(204).send();
  });

  // ---------- Uploads ----------

  app.post("/api/admin/geo/areas/:id/uploads", async (request, reply) => {
    await guard.admin(request);
    const { id: areaId } = idParams.parse(request.params);
    if (!(await prisma.geoArea.findUnique({ where: { id: areaId } }))) throw notFound("Folder");

    const file = await request.file();
    if (!file) throw new AppError(400, "FILE_REQUIRED", "A file is required");
    const format = formatFromFilename(file.filename);
    if (!format) {
      file.file.resume();
      throw new AppError(
        400,
        "UNSUPPORTED_FILE",
        "Only .kml, .json and .geojson files are accepted",
      );
    }

    // The row id names the file on disk, so the row is created first, inside
    // nothing: a failed upload removes both.
    const upload = await prisma.geoUpload.create({
      data: { areaId, filename: file.filename.slice(0, 200), format, storagePath: "" },
    });
    const storagePath = UploadStore.storageName(upload.id, format);
    const discard = async () => {
      await store.remove(storagePath);
      await prisma.geoUpload.delete({ where: { id: upload.id } });
    };

    let sizeBytes: number;
    try {
      sizeBytes = await store.save(storagePath, file.file);
    } catch (error) {
      await discard();
      throw error;
    }
    if (file.file.truncated) {
      await discard();
      const megabytes = Math.floor(deps.maxUploadBytes / 1_048_576);
      throw new AppError(413, "FILE_TOO_LARGE", `The file exceeds the limit of ${megabytes} MB`);
    }
    if (!contentMatchesFormat(await store.head(storagePath), format)) {
      await discard();
      throw new AppError(400, "UNSUPPORTED_FILE", "The content does not match the file extension");
    }

    // Queue the processing in the same transaction that makes the upload visible.
    const saved = await prisma.$transaction(async (tx) => {
      await enqueueJob(tx, "geo.process", { uploadId: upload.id });
      return tx.geoUpload.update({
        where: { id: upload.id },
        data: { storagePath, sizeBytes },
        select: uploadSelect,
      });
    });
    return reply.code(201).send(saved);
  });

  /**
   * Adds to each upload how many of its municipalities have no neighbour at all:
   * islands, which geometry cannot connect and the admin has to link by hand before
   * they can be reached in a match (PROMPT §9 #6).
   */
  async function withIsolated<T extends { id: string }>(uploads: T[]) {
    const counts = await prisma.$queryRaw<{ uploadId: string; n: number }[]>`
      SELECT u."uploadId", count(*)::int AS n FROM "GeoUnit" u
      WHERE u."uploadId" IN (${Prisma.join([...uploads.map((upload) => upload.id), ""])})
        AND NOT EXISTS (SELECT 1 FROM "GeoAdjacency" a WHERE a."aId" = u.id OR a."bId" = u.id)
      GROUP BY u."uploadId"`;
    const byUpload = new Map(counts.map((row) => [row.uploadId, row.n]));
    return uploads.map((upload) => ({ ...upload, isolatedCount: byUpload.get(upload.id) ?? 0 }));
  }

  app.get("/api/admin/geo/uploads", async (request) => {
    await guard.admin(request);
    const { areaId } = uploadsQuery.parse(request.query);
    return withIsolated(
      await prisma.geoUpload.findMany({
        where: { areaId, storagePath: { not: "" } },
        orderBy: { createdAt: "desc" },
        select: uploadSelect,
      }),
    );
  });

  /** The municipalities without any neighbour, for the admin to link by hand. */
  app.get("/api/admin/geo/isolated", async (request) => {
    await guard.admin(request);
    return prisma.$queryRaw<{ id: number; name: string; code: string | null; area: object }[]>`
      SELECT u.id, u.name, u.code, jsonb_build_object('name', a.name) AS area
      FROM "GeoUnit" u JOIN "GeoArea" a ON a.id = u."areaId"
      WHERE NOT EXISTS (SELECT 1 FROM "GeoAdjacency" g WHERE g."aId" = u.id OR g."bId" = u.id)
      ORDER BY a.name, u.name
      LIMIT 500`;
  });

  app.get("/api/admin/geo/uploads/:id", async (request) => {
    await guard.admin(request);
    const { id } = idParams.parse(request.params);
    const upload = await prisma.geoUpload.findUnique({ where: { id }, select: uploadSelect });
    if (!upload) throw notFound("Upload");
    return (await withIsolated([upload]))[0];
  });

  /** Deletes an upload with its municipalities, unless a match uses them or it is being processed. */
  app.delete("/api/admin/geo/uploads/:id", async (request, reply) => {
    await guard.admin(request);
    const { id } = idParams.parse(request.params);
    const upload = await prisma.geoUpload.findUnique({ where: { id } });
    if (!upload) throw notFound("Upload");
    if (upload.status === "PENDING" || upload.status === "PROCESSING") {
      throw new AppError(409, "UPLOAD_IN_PROGRESS", "Wait for the processing to finish");
    }
    try {
      await prisma.geoUpload.delete({ where: { id } });
    } catch (error) {
      if (isForeignKeyError(error)) {
        throw new AppError(409, "UPLOAD_IN_USE", "A match uses these municipalities");
      }
      throw error;
    }
    await store.remove(upload.storagePath);
    return reply.code(204).send();
  });

  // ---------- Units and adjacency ----------

  const unitSummary = {
    id: true,
    name: true,
    code: true,
    area: { select: { name: true } },
  } as const;

  /** Finds municipalities by name, for the adjacency tools. */
  app.get("/api/admin/geo/units", async (request) => {
    await guard.admin(request);
    const { q, limit } = unitsQuery.parse(request.query);
    const [starting, containing] = await Promise.all([
      prisma.geoUnit.findMany({
        where: { name: { startsWith: q, mode: "insensitive" } },
        orderBy: { name: "asc" },
        take: limit,
        select: unitSummary,
      }),
      prisma.geoUnit.findMany({
        where: { name: { contains: q, mode: "insensitive" } },
        orderBy: { name: "asc" },
        take: limit,
        select: unitSummary,
      }),
    ]);
    // Names that start with the query come first.
    const seen = new Set(starting.map((unit) => unit.id));
    return [...starting, ...containing.filter((unit) => !seen.has(unit.id))].slice(0, limit);
  });

  /** The neighbours of a municipality, to check adjacency by hand. */
  app.get("/api/admin/geo/units/:id/neighbours", async (request) => {
    await guard.admin(request);
    const { id } = unitParams.parse(request.params);
    if (!(await prisma.geoUnit.findUnique({ where: { id }, select: { id: true } }))) {
      throw notFound("Municipality");
    }
    const pairs = await prisma.geoAdjacency.findMany({
      where: { OR: [{ aId: id }, { bId: id }] },
      select: { aId: true, manual: true, a: { select: unitSummary }, b: { select: unitSummary } },
    });
    return pairs
      .map((pair) => ({ ...(pair.aId === id ? pair.b : pair.a), manual: pair.manual }))
      .sort((x, y) => x.name.localeCompare(y.name));
  });

  app.get("/api/admin/geo/adjacency/manual", async (request) => {
    await guard.admin(request);
    return prisma.geoAdjacency.findMany({
      where: { manual: true },
      orderBy: [{ a: { name: "asc" } }, { b: { name: "asc" } }],
      select: { a: { select: unitSummary }, b: { select: unitSummary } },
    });
  });

  /** Adds an adjacency by hand, for islands and municipalities that do not touch (PROMPT §9 #6). */
  app.post("/api/admin/geo/adjacency", async (request, reply) => {
    await guard.admin(request);
    const pair = ordered(pairBody.parse(request.body));
    try {
      await prisma.geoAdjacency.create({ data: { ...pair, manual: true } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "ALREADY_ADJACENT", "These municipalities are already adjacent");
      }
      if (isForeignKeyError(error)) throw notFound("Municipality");
      throw error;
    }
    return reply.code(201).send(pair);
  });

  /** Removes a manual adjacency. Computed ones cannot be removed. */
  app.delete("/api/admin/geo/adjacency", async (request, reply) => {
    await guard.admin(request);
    const pair = ordered(pairBody.parse(request.body));
    const { count } = await prisma.geoAdjacency.deleteMany({ where: { ...pair, manual: true } });
    if (count === 0) throw notFound("Manual adjacency");
    return reply.code(204).send();
  });
}
