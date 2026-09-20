import { z } from "zod";

export * from "./models.js";

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
export interface AuthConfig {
  betterAuthSecret: string;
  betterAuthUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  bootstrapAdminEmails: readonly string[];
}
export type WebConfig = CommonConfig;
export interface ProxyConfig extends CommonConfig {
  port: number;
  host: string;
  bodyLimitBytes: number;
  shutdownTimeoutMs: number;
}
/**
 * HUB-owned deployment configuration for the secure OpenAI-compatible data
 * plane (M6/M7) and connection instructions. These are the Hub's OWN names —
 * the Hub does not adopt Sculpin's internal environment-variable naming as its
 * public deployment contract.
 *
 * `sculpinUpstreamUrl` and `sculpinUpstreamApiKey` are DEPLOYMENT configuration
 * only: they are never sourced from an HTTP request, catalogue record, ordinary
 * administrator form, or PAT (SSRF / credential boundary). The API key is the
 * credential the Hub sends upstream to Sculpin; it never reaches the DB,
 * browsers, logs, usage events, or responses.
 */
/**
 * A versioned keyring of PAT HMAC secrets so `PAT_HASH_SECRET` can be ROTATED
 * without invalidating live tokens. Structurally identical to `@sculpin/db`'s
 * `PatKeyring` (config does not depend on db). `currentVersion` is the version
 * new tokens are minted under and MUST be present in `keys`; retired versions
 * stay in `keys` so old tokens keep verifying.
 */
export interface PatHashKeyring {
  readonly currentVersion: number;
  readonly keys: ReadonlyMap<number, string>;
}

export interface DataPlaneConfig {
  hubPublicUrl: string;
  sculpinUpstreamUrl: string;
  sculpinUpstreamApiKey: string;
  /** The CURRENT PAT hash secret (raw), i.e. `keys.get(currentVersion)`. */
  patHashSecret: string;
  /** Full keyring for constructing the PAT service (rotation-aware). */
  patHashKeyring: PatHashKeyring;
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
  const value = parse(baseSchema, input);
  const result = common(value);
  assertProductionDatabaseSafety(result);
  return result;
}

const bootstrapAdminEmails = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
  .pipe(
    z
      .array(
        z.string().max(254).email("must be a list of valid email addresses"),
      )
      .max(64),
  );

const authSchema = z.object({
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "must be at least 32 characters")
    .max(512),
  BETTER_AUTH_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith("https://") || value.startsWith("http://"),
      "must be an absolute http(s) origin",
    ),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  BOOTSTRAP_ADMIN_EMAILS: bootstrapAdminEmails,
});

function assertProductionAuthUrlSafety(
  environment: RuntimeEnvironment,
  betterAuthUrl: string,
): void {
  if (
    environment === "production" &&
    (betterAuthUrl.startsWith("http://") ||
      /localhost|127\.0\.0\.1/.test(betterAuthUrl))
  ) {
    throw new Error(
      "Invalid runtime configuration. Check: BETTER_AUTH_URL production safety.",
    );
  }
}

export function parseWebAuthConfig(input: NodeJS.ProcessEnv): AuthConfig {
  const environment = parse(
    baseSchema.pick({ NODE_ENV: true }),
    input,
  ).NODE_ENV;
  const value = parse(authSchema, input);
  assertProductionAuthUrlSafety(environment, value.BETTER_AUTH_URL);
  return {
    betterAuthSecret: value.BETTER_AUTH_SECRET,
    betterAuthUrl: value.BETTER_AUTH_URL,
    googleClientId: value.GOOGLE_CLIENT_ID,
    googleClientSecret: value.GOOGLE_CLIENT_SECRET,
    githubClientId: value.GITHUB_CLIENT_ID,
    githubClientSecret: value.GITHUB_CLIENT_SECRET,
    bootstrapAdminEmails: value.BOOTSTRAP_ADMIN_EMAILS,
  };
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
      PROXY_SHUTDOWN_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .default(10000),
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
  const result: ProxyConfig = {
    ...common(value),
    port: value.PROXY_PORT,
    host: value.PROXY_HOST,
    bodyLimitBytes: value.PROXY_BODY_LIMIT_BYTES,
    shutdownTimeoutMs: value.PROXY_SHUTDOWN_TIMEOUT_MS,
  };
  assertProductionDatabaseSafety(result);
  return result;
}

const httpUrl = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "must be an http(s) URL",
  );

// Optional retired PAT hash secrets, so tokens minted under an older key still
// verify during/after a rotation. A JSON object mapping version-number -> secret
// (each >= 32 chars), e.g. `{"1":"<old-32+char-secret>"}`. Fails closed on
// malformed JSON, short keys, or non-positive versions; version collisions with
// the CURRENT version are rejected in `parseDataPlaneConfig`.
const patRetiredKeys = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value.trim() === "") return {} as Record<string, string>;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be valid JSON" });
      return z.NEVER;
    }
    return parsed;
  })
  .pipe(
    z.record(
      z
        .string()
        .regex(/^[1-9][0-9]*$/, "must be a positive integer version"),
      z.string().min(32, "must be at least 32 characters").max(512),
    ),
  );

const dataPlaneSchema = z.object({
  NODE_ENV: environmentSchema.default("development"),
  // The canonical, public Hub origin used to render connection instructions
  // (never derived from a request Host header).
  HUB_PUBLIC_URL: httpUrl,
  // Deployment-only upstream target. Never sourced from a request/catalogue/PAT.
  SCULPIN_UPSTREAM_URL: httpUrl,
  // Server secret the Hub sends to Sculpin as `Authorization: Bearer ...`.
  SCULPIN_UPSTREAM_API_KEY: z.string().min(1).max(4096),
  // Keyed HMAC secret for PAT verification, held OUTSIDE the database. This is
  // the CURRENT key.
  PAT_HASH_SECRET: z.string().min(32, "must be at least 32 characters").max(512),
  // Version number the CURRENT key is stamped under (default 1).
  PAT_HASH_KEY_VERSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(32767)
    .default(1),
  // Optional retired keys so pre-rotation tokens still verify.
  PAT_HASH_SECRET_RETIRED: patRetiredKeys,
});

/**
 * Parse and validate the data-plane deployment configuration. Fails closed:
 * any missing/invalid required value throws a secret-safe error (field names
 * only). In production `HUB_PUBLIC_URL` must be a non-local https origin.
 */
export function parseDataPlaneConfig(input: NodeJS.ProcessEnv): DataPlaneConfig {
  const value = parse(dataPlaneSchema, input);
  if (
    value.NODE_ENV === "production" &&
    (value.HUB_PUBLIC_URL.startsWith("http://") ||
      /localhost|127\.0\.0\.1/.test(value.HUB_PUBLIC_URL))
  ) {
    throw new Error(
      "Invalid runtime configuration. Check: HUB_PUBLIC_URL production safety.",
    );
  }
  const currentVersion = value.PAT_HASH_KEY_VERSION;
  // Build the keyring from retired keys, then set the CURRENT key last so it is
  // authoritative for its version. A retired entry that names the CURRENT
  // version is a collision — fail closed rather than silently overriding.
  const keys = new Map<number, string>();
  for (const [rawVersion, secret] of Object.entries(
    value.PAT_HASH_SECRET_RETIRED,
  )) {
    const version = Number(rawVersion);
    if (version === currentVersion)
      throw new Error(
        "Invalid runtime configuration. Check: PAT_HASH_SECRET_RETIRED version collision.",
      );
    keys.set(version, secret);
  }
  keys.set(currentVersion, value.PAT_HASH_SECRET);
  return {
    hubPublicUrl: value.HUB_PUBLIC_URL,
    sculpinUpstreamUrl: value.SCULPIN_UPSTREAM_URL,
    sculpinUpstreamApiKey: value.SCULPIN_UPSTREAM_API_KEY,
    patHashSecret: value.PAT_HASH_SECRET,
    patHashKeyring: { currentVersion, keys },
  };
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
