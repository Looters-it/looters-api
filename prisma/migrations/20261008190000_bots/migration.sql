-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false;


-- The settings of bots, for the matches that exist: off, with the defaults.
UPDATE "Match" SET config = jsonb_build_object('botsEnabled', false, 'botsMax', 5, 'botSpawnChancePct', 30) || config;
