-- Game modes: how a match is played (alone against bots or with people), at what
-- pace (rush or normal), who can see it, and a status for each stage of its life.

-- A draft was a match nobody but its owner had seen: there are none any more, a
-- match is planned as soon as it is created.
DELETE FROM "Match" WHERE status = 'DRAFT';

CREATE TYPE "MatchStatus_new" AS ENUM ('PLANNED', 'ONGOING', 'FINISHED');
ALTER TABLE "Match" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Match" ALTER COLUMN "status" TYPE "MatchStatus_new" USING (
  CASE "status"::text WHEN 'OPEN' THEN 'PLANNED' WHEN 'RUNNING' THEN 'ONGOING' ELSE "status"::text END
)::"MatchStatus_new";
DROP TYPE "MatchStatus";
ALTER TYPE "MatchStatus_new" RENAME TO "MatchStatus";
ALTER TABLE "Match" ALTER COLUMN "status" SET DEFAULT 'PLANNED';

CREATE TYPE "MatchMode" AS ENUM ('SINGLEPLAYER', 'MULTIPLAYER');
CREATE TYPE "MatchPace" AS ENUM ('RUSH', 'NORMAL');
CREATE TYPE "MatchVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

ALTER TABLE "Match"
  ADD COLUMN "mode" "MatchMode" NOT NULL DEFAULT 'MULTIPLAYER',
  ADD COLUMN "pace" "MatchPace" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "visibility" "MatchVisibility" NOT NULL DEFAULT 'PUBLIC';

-- A match that asked for a code to join was private in all but name.
UPDATE "Match" SET "visibility" = 'PRIVATE' WHERE "inviteCode" IS NOT NULL;

-- Bots that are there from the first turn: none in the matches that exist.
UPDATE "Match" SET config = config || '{"botsAtStart": 0}'::jsonb WHERE NOT (config ? 'botsAtStart');
