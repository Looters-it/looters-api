import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests share one database.
    fileParallelism: false,
    // Makes TEST_DATABASE_URL and TEST_KAFKA_BROKERS from .env visible to the tests.
    env: loadEnv("test", process.cwd(), "TEST_"),
  },
});
