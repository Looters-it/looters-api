/*
  Warnings:

  - You are about to drop the column `kind` on the `GeoArea` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "GeoArea" DROP COLUMN "kind";

-- AlterTable
ALTER TABLE "GeoUpload" ADD COLUMN     "adjacencyCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "sizeBytes" INTEGER NOT NULL DEFAULT 0;

-- DropEnum
DROP TYPE "GeoAreaKind";
