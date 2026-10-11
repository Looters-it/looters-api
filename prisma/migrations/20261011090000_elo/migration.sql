-- What a finished match leaves to who played it, and what each player has gathered.
ALTER TABLE "Empire" ADD COLUMN "place" INTEGER, ADD COLUMN "award" INTEGER;
ALTER TABLE "User" ADD COLUMN "elo" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ratedMatches" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ratedTurns" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "User_elo_idx" ON "User"("elo" DESC);
