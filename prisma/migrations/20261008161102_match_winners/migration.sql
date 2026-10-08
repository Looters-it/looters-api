-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "winnerEmpireIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
