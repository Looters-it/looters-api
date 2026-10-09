import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/auth/password.js";
import { createPrisma } from "../src/db/prisma.js";
import { enqueueJob } from "../src/queue/jobs.js";
import { DEFAULT_MATCH_RULES } from "../src/rules/config.js";
import { seedAdmin } from "../src/seed/admin.js";

// Needs a migrated, disposable database: set TEST_DATABASE_URL (see .env.example).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("database integration", () => {
  const prisma = createPrisma(url ?? "");

  beforeEach(async () => {
    await prisma.job.deleteMany();
    await prisma.match.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const admin = { username: "admin", email: "admin@example.test", password: "first-password-123" };

  it("seeds the admin once and realigns it on the next run", async () => {
    expect(await seedAdmin(prisma, admin)).toBe("created");
    expect(await seedAdmin(prisma, { ...admin, password: "second-password-456" })).toBe("updated");

    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe("ADMIN");
    expect(users[0]?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(users[0]?.passwordHash ?? "", "second-password-456")).toBe(true);
    expect(await verifyPassword(users[0]?.passwordHash ?? "", admin.password)).toBe(false);
  });

  it("never promotes a normal user to admin", async () => {
    await prisma.user.create({
      data: { username: "admin", email: "someone@example.test", passwordHash: "x" },
    });
    await expect(seedAdmin(prisma, admin)).rejects.toThrow(/normal user/);
    expect((await prisma.user.findUniqueOrThrow({ where: { username: "admin" } })).role).toBe(
      "USER",
    );
  });

  it("allows two users with the same email but not the same username", async () => {
    const data = { email: "shared@example.test", passwordHash: "x" };
    await prisma.user.create({ data: { ...data, username: "one" } });
    await prisma.user.create({ data: { ...data, username: "two" } });
    await expect(prisma.user.create({ data: { ...data, username: "one" } })).rejects.toThrow();
  });

  it("enqueues a job once per dedupe key", async () => {
    const payload = { matchId: "m1", turn: 3 };
    expect(await enqueueJob(prisma, "turn.close", payload, { dedupeKey: "turn.close:m1:3" })).toBe(
      true,
    );
    expect(await enqueueJob(prisma, "turn.close", payload, { dedupeKey: "turn.close:m1:3" })).toBe(
      false,
    );
    expect(await prisma.job.count()).toBe(1);
  });

  it("has PostGIS enabled", async () => {
    const rows = await prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT ST_Intersects(
        ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))', 4326),
        ST_GeomFromText('POINT(0.5 0.5)', 4326)
      ) AS ok`;
    expect(rows[0]?.ok).toBe(true);
  });

  describe("constraints of the game model", () => {
    async function createMatch() {
      const owner = await prisma.user.create({
        data: { username: "owner", email: "o@example.test", passwordHash: "x" },
      });
      return prisma.match.create({
        data: { name: "Test", ownerId: owner.id, startAt: new Date(), config: DEFAULT_MATCH_RULES },
      });
    }

    it("starts a match as planned, multiplayer, normal and public", async () => {
      expect(await createMatch()).toMatchObject({
        status: "PLANNED",
        mode: "MULTIPLAYER",
        pace: "NORMAL",
        visibility: "PUBLIC",
      });
    });

    it("refuses negative resources on a territory", async () => {
      const match = await createMatch();
      const territory = await prisma.territory.create({
        data: { matchId: match.id, name: "Abbiategrasso", resources: 10 },
      });
      await expect(
        prisma.territory.update({
          where: { id: territory.id },
          data: { resources: { decrement: 11 } },
        }),
      ).rejects.toThrow();
    });

    it("allows a territory in one open battle only", async () => {
      const match = await createMatch();
      const territory = await prisma.territory.create({
        data: { matchId: match.id, name: "Magenta" },
      });
      const battle = {
        matchId: match.id,
        turn: 1,
        attackerEmpireId: "a",
        defenderEmpireId: "d",
        targetTerritoryId: territory.id,
        attackPct: 50,
        attackCost: 10,
        attackForce: 20,
      };
      const first = await prisma.battle.create({ data: battle });
      const second = await prisma.battle.create({ data: battle });
      await prisma.battleLock.create({ data: { territoryId: territory.id, battleId: first.id } });
      await expect(
        prisma.battleLock.create({ data: { territoryId: territory.id, battleId: second.id } }),
      ).rejects.toThrow();
    });
  });
});
