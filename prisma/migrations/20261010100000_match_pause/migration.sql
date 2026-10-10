-- A single-player match can be paused: the clock of the turn stands still.
ALTER TABLE "Match" ADD COLUMN "pausedAt" TIMESTAMP(3);
