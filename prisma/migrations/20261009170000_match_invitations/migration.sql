-- Invitations to private matches: the owner names who may come in.
CREATE TABLE "MatchInvitation" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MatchInvitation_matchId_userId_key" ON "MatchInvitation"("matchId", "userId");
CREATE INDEX "MatchInvitation_userId_idx" ON "MatchInvitation"("userId");

ALTER TABLE "MatchInvitation" ADD CONSTRAINT "MatchInvitation_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchInvitation" ADD CONSTRAINT "MatchInvitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The code that let into a private match gives way to invitations.
UPDATE "Match" SET "inviteCode" = NULL;
