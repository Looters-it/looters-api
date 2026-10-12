-- A battle nobody wins clearly stays open: it is fought again, one round a turn.
ALTER TYPE "BattleOutcome" ADD VALUE 'WITHDRAWN';

ALTER TABLE "Battle"
  ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "foughtTurn" INTEGER,
  ADD COLUMN "withdrawn" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "share" DOUBLE PRECISION;

CREATE TABLE "BattleRound" (
  "battleId" TEXT NOT NULL,
  "round" INTEGER NOT NULL,
  "turn" INTEGER NOT NULL,
  "attackForce" INTEGER NOT NULL,
  "attackCost" INTEGER NOT NULL,
  "defenseForce" INTEGER NOT NULL,
  "defenseCost" INTEGER NOT NULL,
  "rollAttack" DOUBLE PRECISION NOT NULL,
  "rollDefense" DOUBLE PRECISION NOT NULL,
  "share" DOUBLE PRECISION NOT NULL,
  "result" TEXT NOT NULL,
  CONSTRAINT "BattleRound_pkey" PRIMARY KEY ("battleId", "round"),
  CONSTRAINT "BattleRound_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "Battle"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
