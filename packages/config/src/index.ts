import { z } from "zod";

const environmentSchema = z.enum(["development", "test", "production"]);
const port = z.coerce.number().int().min(1).max(65535);
const baseSchema = z.object({
  NODE_ENV: environmentSchema.default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (value) =>
        value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "must be a PostgreSQL URL",
    ),
});

export type RuntimeEnvironment = z.infer<typeof environmentSchema>;
export interface CommonConfig {
  environment: RuntimeEnvironment;
  logLevel: string;
  databaseUrl: string;
}
export interface WebConfig extends CommonConfig {
  port: number;
}
export interface ProxyConfig extends CommonConfig {
  port: number;
  host: string;
  bodyLimitBytes: number;
}
export interface WorkerConfig extends CommonConfig {
  shutdownTimeoutMs: number;
}

function formatIssues(error: z.ZodError): Error {
  const fields = [
    ...new Set(
      error.issues.map((issue) => issue.path.join(".") || "configuration"),
    ),
  ];
  return new Error(
    `Invalid runtime configuration. Check: ${fields.join(", ")}.`,
  );
}
function parse<T>(schema: z.ZodType<T>, input: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(input);
  if (!result.success) throw formatIssues(result.error);
  return result.data;
}
function assertProductionDatabaseSafety(config: CommonConfig): void {
  if (
    config.environment === "production" &&
    (/localhost|127\.0\.0\.1/.test(config.databaseUrl) ||
      config.databaseUrl.includes("local-development-only"))
  ) {
    throw new Error(
      "Invalid runtime configuration. Check: DATABASE_URL production safety.",
    );
  }
}
function common(value: z.infer<typeof baseSchema>): CommonConfig {
  return {
    environment: value.NODE_ENV,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
  };
}
export function parseWebConfig(input: NodeJS.ProcessEnv): WebConfig {
  const value = parse(
    baseSchema.extend({ WEB_PORT: port.default(3000) }),
    input,
  );
  const result = { ...common(value), port: value.WEB_PORT };
  assertProductionDatabaseSafety(result);
  return result;
}
export function parseProxyConfig(input: NodeJS.ProcessEnv): ProxyConfig {
  const schema = baseSchema
    .extend({
      PROXY_PORT: port.default(3001),
      PROXY_HOST: z.string().min(1).default("127.0.0.1"),
      PROXY_BODY_LIMIT_BYTES: z.coerce
        .number()
        .int()
        .min(1024)
        .max(10 * 1024 * 1024)
        .default(1024 * 1024),
    })
    .superRefine((value, context) => {
      if (
        value.NODE_ENV === "production" &&
        ["0.0.0.0", "::"].includes(value.PROXY_HOST) &&
        !input.PROXY_HOST
      ) {
        context.addIssue({
          code: "custom",
          path: ["PROXY_HOST"],
          message: "must be explicit in production",
        });
      }
    });
  const value = parse(schema, input);
  const result = {
    ...common(value),
    port: value.PROXY_PORT,
    host: value.PROXY_HOST,
    bodyLimitBytes: value.PROXY_BODY_LIMIT_BYTES,
  };
  assertProductionDatabaseSafety(result);
  return result;
}
export function parseWorkerConfig(input: NodeJS.ProcessEnv): WorkerConfig {
  const value = parse(
    baseSchema.extend({
      WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .default(10000),
    }),
    input,
  );
  const result = {
    ...common(value),
    shutdownTimeoutMs: value.WORKER_SHUTDOWN_TIMEOUT_MS,
  };
  assertProductionDatabaseSafety(result);
  return result;
}
