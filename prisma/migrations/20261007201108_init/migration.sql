-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "GeoAreaKind" AS ENUM ('FOLDER', 'DATASET');

-- CreateEnum
CREATE TYPE "GeoFormat" AS ENUM ('KML', 'GEOJSON');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('DRAFT', 'OPEN', 'RUNNING', 'FINISHED');

-- CreateEnum
CREATE TYPE "EmpireStatus" AS ENUM ('ACTIVE', 'FALLEN');

-- CreateEnum
CREATE TYPE "AllocationMode" AS ENUM ('EQUAL', 'WEIGHTED');

-- CreateEnum
CREATE TYPE "BattleStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "BattleResponse" AS ENUM ('DEFEND', 'SURRENDER');

-- CreateEnum
CREATE TYPE "BattleOutcome" AS ENUM ('ATTACKER_WON', 'DEFENDER_WON', 'SURRENDER');

-- CreateEnum
CREATE TYPE "AllianceInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoArea" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "GeoAreaKind" NOT NULL DEFAULT 'FOLDER',
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoUpload" (
    "id" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "format" "GeoFormat" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "unitCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoUnit" (
    "id" SERIAL NOT NULL,
    "areaId" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "centroidLon" DOUBLE PRECISION NOT NULL,
    "centroidLat" DOUBLE PRECISION NOT NULL,
    "areaKm2" DOUBLE PRECISION NOT NULL,
    "geom" geometry(MultiPolygon,4326) NOT NULL,
    "geomSimple" geometry(MultiPolygon,4326) NOT NULL,

    CONSTRAINT "GeoUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoAdjacency" (
    "aId" INTEGER NOT NULL,
    "bId" INTEGER NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "GeoAdjacency_pkey" PRIMARY KEY ("aId","bId")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'DRAFT',
    "startAt" TIMESTAMP(3) NOT NULL,
    "maxDays" INTEGER,
    "maxPlayers" INTEGER NOT NULL DEFAULT 100,
    "turnHours" DOUBLE PRECISION NOT NULL DEFAULT 24,
    "currentTurn" INTEGER NOT NULL DEFAULT 0,
    "turnEndsAt" TIMESTAMP(3),
    "inviteCode" TEXT,
    "config" JSONB NOT NULL,
    "winnerEmpireId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchArea" (
    "matchId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,

    CONSTRAINT "MatchArea_pkey" PRIMARY KEY ("matchId","areaId")
);

-- CreateTable
CREATE TABLE "Empire" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "emblem" TEXT NOT NULL,
    "motto" TEXT,
    "status" "EmpireStatus" NOT NULL DEFAULT 'ACTIVE',
    "allocationMode" "AllocationMode" NOT NULL DEFAULT 'EQUAL',
    "capitalTerritoryId" TEXT,
    "annexedThisTurn" INTEGER NOT NULL DEFAULT 0,
    "lastCapitalMoveTurn" INTEGER,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fallenTurn" INTEGER,

    CONSTRAINT "Empire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Territory" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerEmpireId" TEXT,
    "resources" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "isArea" BOOLEAN NOT NULL DEFAULT false,
    "protectedUntilTurn" INTEGER,
    "aboveAlertAtLastClose" BOOLEAN NOT NULL DEFAULT false,
    "alert" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Territory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerritoryUnit" (
    "matchId" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "geoUnitId" INTEGER NOT NULL,

    CONSTRAINT "TerritoryUnit_pkey" PRIMARY KEY ("matchId","geoUnitId")
);

-- CreateTable
CREATE TABLE "Battle" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "attackerEmpireId" TEXT NOT NULL,
    "defenderEmpireId" TEXT NOT NULL,
    "targetTerritoryId" TEXT NOT NULL,
    "status" "BattleStatus" NOT NULL DEFAULT 'OPEN',
    "response" "BattleResponse",
    "respondedAt" TIMESTAMP(3),
    "outcome" "BattleOutcome",
    "resolver" TEXT,
    "attackPct" INTEGER NOT NULL,
    "attackCost" INTEGER NOT NULL,
    "attackForce" INTEGER NOT NULL,
    "defenseCost" INTEGER,
    "defenseForce" INTEGER,
    "rollAttack" DOUBLE PRECISION,
    "rollDefense" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Battle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BattleSource" (
    "battleId" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "resourcesAtDeclaration" INTEGER NOT NULL,

    CONSTRAINT "BattleSource_pkey" PRIMARY KEY ("battleId","territoryId")
);

-- CreateTable
CREATE TABLE "BattleLock" (
    "territoryId" TEXT NOT NULL,
    "battleId" TEXT NOT NULL,

    CONSTRAINT "BattleLock_pkey" PRIMARY KEY ("territoryId")
);

-- CreateTable
CREATE TABLE "Structure" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "empireId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "builtTurn" INTEGER NOT NULL,
    "expiresTurn" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "cooldownUntilTurn" INTEGER,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Structure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alliance" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "createdTurn" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dissolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alliance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllianceMember" (
    "empireId" TEXT NOT NULL,
    "allianceId" TEXT NOT NULL,
    "joinedTurn" INTEGER NOT NULL,
    "leavesAtTurn" INTEGER,

    CONSTRAINT "AllianceMember_pkey" PRIMARY KEY ("empireId")
);

-- CreateTable
CREATE TABLE "AllianceInvite" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "allianceId" TEXT,
    "fromEmpireId" TEXT NOT NULL,
    "toEmpireId" TEXT NOT NULL,
    "status" "AllianceInviteStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "AllianceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllianceMessage" (
    "id" TEXT NOT NULL,
    "allianceId" TEXT NOT NULL,
    "empireId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllianceMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "empireId" TEXT,
    "territoryId" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "data" JSONB NOT NULL DEFAULT '{}',
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TurnSnapshot" (
    "matchId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "ownership" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TurnSnapshot_pkey" PRIMARY KEY ("matchId","turn")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "GeoArea_parentId_idx" ON "GeoArea"("parentId");

-- CreateIndex
CREATE INDEX "GeoUpload_areaId_idx" ON "GeoUpload"("areaId");

-- CreateIndex
CREATE INDEX "GeoUnit_areaId_idx" ON "GeoUnit"("areaId");

-- CreateIndex
CREATE INDEX "GeoUnit_uploadId_idx" ON "GeoUnit"("uploadId");

-- CreateIndex
CREATE INDEX "GeoUnit_geom_idx" ON "GeoUnit" USING GIST ("geom");

-- CreateIndex
CREATE INDEX "GeoAdjacency_bId_idx" ON "GeoAdjacency"("bId");

-- CreateIndex
CREATE INDEX "Match_status_idx" ON "Match"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Empire_capitalTerritoryId_key" ON "Empire"("capitalTerritoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Empire_matchId_userId_key" ON "Empire"("matchId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Empire_matchId_name_key" ON "Empire"("matchId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Empire_matchId_color_key" ON "Empire"("matchId", "color");

-- CreateIndex
CREATE INDEX "Territory_matchId_idx" ON "Territory"("matchId");

-- CreateIndex
CREATE INDEX "Territory_ownerEmpireId_idx" ON "Territory"("ownerEmpireId");

-- CreateIndex
CREATE INDEX "TerritoryUnit_territoryId_idx" ON "TerritoryUnit"("territoryId");

-- CreateIndex
CREATE INDEX "TerritoryUnit_geoUnitId_idx" ON "TerritoryUnit"("geoUnitId");

-- CreateIndex
CREATE INDEX "Battle_matchId_status_idx" ON "Battle"("matchId", "status");

-- CreateIndex
CREATE INDEX "Battle_targetTerritoryId_idx" ON "Battle"("targetTerritoryId");

-- CreateIndex
CREATE INDEX "BattleSource_territoryId_idx" ON "BattleSource"("territoryId");

-- CreateIndex
CREATE INDEX "BattleLock_battleId_idx" ON "BattleLock"("battleId");

-- CreateIndex
CREATE INDEX "Structure_matchId_type_idx" ON "Structure"("matchId", "type");

-- CreateIndex
CREATE INDEX "Structure_territoryId_idx" ON "Structure"("territoryId");

-- CreateIndex
CREATE INDEX "Structure_empireId_idx" ON "Structure"("empireId");

-- CreateIndex
CREATE INDEX "Alliance_matchId_idx" ON "Alliance"("matchId");

-- CreateIndex
CREATE INDEX "AllianceMember_allianceId_idx" ON "AllianceMember"("allianceId");

-- CreateIndex
CREATE INDEX "AllianceInvite_matchId_idx" ON "AllianceInvite"("matchId");

-- CreateIndex
CREATE INDEX "AllianceInvite_toEmpireId_status_idx" ON "AllianceInvite"("toEmpireId", "status");

-- CreateIndex
CREATE INDEX "AllianceMessage_allianceId_createdAt_idx" ON "AllianceMessage"("allianceId", "createdAt");

-- CreateIndex
CREATE INDEX "GameEvent_matchId_createdAt_idx" ON "GameEvent"("matchId", "createdAt");

-- CreateIndex
CREATE INDEX "GameEvent_matchId_turn_idx" ON "GameEvent"("matchId", "turn");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupeKey_key" ON "Job"("dedupeKey");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoArea" ADD CONSTRAINT "GeoArea_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "GeoArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoUpload" ADD CONSTRAINT "GeoUpload_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "GeoArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoUnit" ADD CONSTRAINT "GeoUnit_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "GeoArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoUnit" ADD CONSTRAINT "GeoUnit_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "GeoUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoAdjacency" ADD CONSTRAINT "GeoAdjacency_aId_fkey" FOREIGN KEY ("aId") REFERENCES "GeoUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoAdjacency" ADD CONSTRAINT "GeoAdjacency_bId_fkey" FOREIGN KEY ("bId") REFERENCES "GeoUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchArea" ADD CONSTRAINT "MatchArea_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchArea" ADD CONSTRAINT "MatchArea_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "GeoArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Empire" ADD CONSTRAINT "Empire_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Empire" ADD CONSTRAINT "Empire_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Territory" ADD CONSTRAINT "Territory_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Territory" ADD CONSTRAINT "Territory_ownerEmpireId_fkey" FOREIGN KEY ("ownerEmpireId") REFERENCES "Empire"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryUnit" ADD CONSTRAINT "TerritoryUnit_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryUnit" ADD CONSTRAINT "TerritoryUnit_geoUnitId_fkey" FOREIGN KEY ("geoUnitId") REFERENCES "GeoUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Battle" ADD CONSTRAINT "Battle_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BattleSource" ADD CONSTRAINT "BattleSource_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "Battle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BattleLock" ADD CONSTRAINT "BattleLock_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BattleLock" ADD CONSTRAINT "BattleLock_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "Battle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Structure" ADD CONSTRAINT "Structure_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Structure" ADD CONSTRAINT "Structure_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Structure" ADD CONSTRAINT "Structure_empireId_fkey" FOREIGN KEY ("empireId") REFERENCES "Empire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alliance" ADD CONSTRAINT "Alliance_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllianceMember" ADD CONSTRAINT "AllianceMember_empireId_fkey" FOREIGN KEY ("empireId") REFERENCES "Empire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllianceMember" ADD CONSTRAINT "AllianceMember_allianceId_fkey" FOREIGN KEY ("allianceId") REFERENCES "Alliance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllianceInvite" ADD CONSTRAINT "AllianceInvite_allianceId_fkey" FOREIGN KEY ("allianceId") REFERENCES "Alliance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllianceMessage" ADD CONSTRAINT "AllianceMessage_allianceId_fkey" FOREIGN KEY ("allianceId") REFERENCES "Alliance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TurnSnapshot" ADD CONSTRAINT "TurnSnapshot_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Constraints Prisma cannot express.

-- Resource balances can never go negative, whatever runs in parallel.
ALTER TABLE "Territory" ADD CONSTRAINT "Territory_resources_nonnegative" CHECK ("resources" >= 0);
ALTER TABLE "Territory" ADD CONSTRAINT "Territory_weight_nonnegative" CHECK ("weight" >= 0);

-- Adjacency is undirected: one row per pair, smaller id first.
ALTER TABLE "GeoAdjacency" ADD CONSTRAINT "GeoAdjacency_ordered" CHECK ("aId" < "bId");
