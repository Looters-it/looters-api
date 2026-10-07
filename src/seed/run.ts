import { loadSeedEnv } from "../config/env.js";
import { createPrisma } from "../db/prisma.js";
import { seedAdmin } from "./admin.js";

const env = loadSeedEnv();
const prisma = createPrisma(env.DATABASE_URL);
try {
  const result = await seedAdmin(prisma, {
    username: env.ADMIN_USERNAME,
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
  });
  console.log(`Platform admin "${env.ADMIN_USERNAME}" ${result}.`);
} finally {
  await prisma.$disconnect();
}
