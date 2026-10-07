import { describe, expect, it } from "vitest";
import { loadSeedEnv, loadServerEnv } from "../src/config/env.js";

const DATABASE_URL = "postgresql://u:p@localhost:5432/db";

describe("server environment", () => {
  const required = { DATABASE_URL, KAFKA_BROKERS: "kafka-1:9092, kafka-2:9092" };

  it("applies defaults", () => {
    const env = loadServerEnv(required);
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.KAFKA_BROKERS).toEqual(["kafka-1:9092", "kafka-2:9092"]);
    expect(env.KAFKA_BATTLE_TOPIC).toBe("battle.resolve");
  });

  it("names the invalid variable", () => {
    expect(() => loadServerEnv({ KAFKA_BROKERS: "k:9092" })).toThrow(/DATABASE_URL/);
    expect(() => loadServerEnv({ ...required, PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadServerEnv({ DATABASE_URL })).toThrow(/KAFKA_BROKERS/);
    expect(() => loadServerEnv({ DATABASE_URL, KAFKA_BROKERS: " , " })).toThrow(/KAFKA_BROKERS/);
  });
});

describe("seed environment", () => {
  const valid = {
    DATABASE_URL,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "a-long-enough-password",
    ADMIN_EMAIL: "admin@example.test",
  };

  it("accepts complete credentials", () => {
    expect(loadSeedEnv(valid).ADMIN_USERNAME).toBe("admin");
  });

  it("rejects a missing or short password", () => {
    expect(() => loadSeedEnv({ ...valid, ADMIN_PASSWORD: undefined })).toThrow(/ADMIN_PASSWORD/);
    expect(() => loadSeedEnv({ ...valid, ADMIN_PASSWORD: "short" })).toThrow(/ADMIN_PASSWORD/);
  });
});
