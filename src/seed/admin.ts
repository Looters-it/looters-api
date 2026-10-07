import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "../auth/password.js";

export interface AdminCredentials {
  username: string;
  email: string;
  password: string;
}

export type SeedAdminResult = "created" | "updated";

/**
 * Creates the platform admin, or realigns it with the given credentials.
 * This is the only way an admin can exist: no API route creates one.
 * Refuses to promote an existing normal user that has the same username.
 */
export async function seedAdmin(
  prisma: PrismaClient,
  credentials: AdminCredentials,
): Promise<SeedAdminResult> {
  const { username, email, password } = credentials;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing && existing.role !== "ADMIN") {
    throw new Error(
      `Username "${username}" already belongs to a normal user: choose another ADMIN_USERNAME`,
    );
  }

  const passwordHash = await hashPassword(password);
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { email, passwordHash } });
    return "updated";
  }
  await prisma.user.create({ data: { username, email, passwordHash, role: "ADMIN" } });
  return "created";
}
