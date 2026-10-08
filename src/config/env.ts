import { z } from "zod";

/** "true" / "false", as environment variables spell booleans. */
const flag = z.enum(["true", "false"]).transform((value) => value === "true");

const serverEnvSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  UPLOAD_DIR: z.string().default("./uploads"),
  UPLOAD_MAX_MB: z.coerce.number().int().positive().default(300),
  TILE_CACHE_MB: z.coerce.number().int().positive().default(128),
  MATCH_STATE_CACHE_MS: z.coerce.number().int().min(0).max(60_000).default(1000),
  MATCH_UPDATE_WINDOW_MS: z.coerce.number().int().min(0).max(60_000).default(1000),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(500).optional(),
  KAFKA_BROKERS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((broker) => broker.trim())
        .filter(Boolean),
    )
    .refine((brokers) => brokers.length > 0, "at least one broker is required"),
  KAFKA_BATTLE_TOPIC: z.string().min(1).default("battle.resolve"),

  SESSION_COOKIE_NAME: z.string().min(1).default("sid"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(720),
  COOKIE_SECURE: flag.default(false),
  TRUST_PROXY: flag.default(false),
  LOGIN_RATE_MAX: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_WINDOW_SEC: z.coerce.number().int().positive().default(300),
  REGISTER_RATE_MAX: z.coerce.number().int().positive().default(10),
  REGISTER_RATE_WINDOW_SEC: z.coerce.number().int().positive().default(3600),
});

const seedEnvSchema = z.object({
  DATABASE_URL: z.url(),
  ADMIN_USERNAME: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[A-Za-z0-9_]+$/, "only letters, digits and underscore"),
  ADMIN_PASSWORD: z.string().min(12, "must be at least 12 characters"),
  ADMIN_EMAIL: z.email(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type SeedEnv = z.infer<typeof seedEnvSchema>;

function parse<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  return result.data;
}

export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return parse(serverEnvSchema, source);
}

export function loadSeedEnv(source: NodeJS.ProcessEnv = process.env): SeedEnv {
  return parse(seedEnvSchema, source);
}
