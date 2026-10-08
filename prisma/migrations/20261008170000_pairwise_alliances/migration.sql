-- Alliances become pacts between two empires. The groups that exist cannot be told
-- apart into pairs, so they are dissolved; the limit of a match changes meaning with
-- them, from members of a group to allies of an empire.
DELETE FROM "AllianceInvite";
DELETE FROM "Alliance";
UPDATE "Match" SET config = (config - 'allianceMaxMembers')
  || jsonb_build_object('allianceMaxAllies', greatest(1, coalesce((config->>'allianceMaxMembers')::int, 3) - 1))
WHERE config ? 'allianceMaxMembers';

-- DropForeignKey
ALTER TABLE "AllianceInvite" DROP CONSTRAINT "AllianceInvite_allianceId_fkey";

-- DropForeignKey
ALTER TABLE "AllianceMember" DROP CONSTRAINT "AllianceMember_allianceId_fkey";

-- DropForeignKey
ALTER TABLE "AllianceMember" DROP CONSTRAINT "AllianceMember_empireId_fkey";

-- AlterTable
ALTER TABLE "Alliance" DROP COLUMN "dissolvedAt",
ADD COLUMN     "aEmpireId" TEXT NOT NULL,
ADD COLUMN     "bEmpireId" TEXT NOT NULL,
ADD COLUMN     "endedByEmpireId" TEXT,
ADD COLUMN     "endsAtTurn" INTEGER;

-- AlterTable
ALTER TABLE "AllianceInvite" DROP COLUMN "allianceId";

-- DropTable
DROP TABLE "AllianceMember";

-- CreateIndex
CREATE INDEX "Alliance_bEmpireId_idx" ON "Alliance"("bEmpireId");

-- CreateIndex
CREATE UNIQUE INDEX "Alliance_aEmpireId_bEmpireId_key" ON "Alliance"("aEmpireId", "bEmpireId");

-- AddForeignKey
ALTER TABLE "Alliance" ADD CONSTRAINT "Alliance_aEmpireId_fkey" FOREIGN KEY ("aEmpireId") REFERENCES "Empire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alliance" ADD CONSTRAINT "Alliance_bEmpireId_fkey" FOREIGN KEY ("bEmpireId") REFERENCES "Empire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

