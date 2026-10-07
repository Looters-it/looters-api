-- Usernames are unique regardless of case: "Mario" and "mario" are the same player.
-- Prisma cannot express an index on an expression, so it lives here.
CREATE UNIQUE INDEX "User_username_lower_key" ON "User" (lower("username"));
