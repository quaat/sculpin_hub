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
  /**
   * TEST-ONLY authentication seam (S15 browser E2E). `true` ONLY when
   * `E2E_TEST_AUTH === "1"` AND `NODE_ENV !== "production"`. Enabling it under
   * production is a HARD startup failure (see `parseWebAuthConfig`), so a
   * production deployment that accidentally carries the flag fails closed rather
   * than exposing the session-minting seam. When false the seam plugin is never
   * constructed, so the `/api/auth/e2e/*` route is structurally absent.
   */
  e2eTestAuth: boolean;
  /**
   * SERVER-ONLY secret guarding the E2E session seam. Present (>= 32 chars) only
   * when `e2eTestAuth` is true. Never reaches a browser bundle or client surface;
   * the Playwright fixture sends it as the `x-e2e-seed-key` request header from a
   * Node request context, never from page JS.
   */
  e2eSessionSeedKey?: string;
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

/**
 * Least-privilege PAT-hashing configuration for the WEB control plane.
 *
 * Minting, verifying, and revoking PATs needs ONLY the keyed HMAC keyring (kept
 * OUTSIDE the DB) — it does NOT need the data plane's request-serving upstream
 * target or credential. This slice lets the web app hold just the PAT secret,
 * so a compromised control plane cannot read the upstream Sculpin key. The data
 * plane composes this same shape into its own broader `DataPlaneConfig`.
 */
export interface PatConfig {
  /** The CURRENT PAT hash secret (raw), i.e. `keys.get(currentVersion)`. */
  patHashSecret: string;
  /** Full keyring for constructing the PAT service (rotation-aware). */
  patHashKeyring: PatHashKeyring;
}

export interface DataPlaneConfig extends PatConfig {
  hubPublicUrl: string;
  sculpinUpstreamUrl: string;
  sculpinUpstreamApiKey: string;
  upstreamTimeoutMs: number;
}

/**
 * S5 admin-only Sculpin DISCOVERY configuration (least-privilege slice).
 *
 * Server-side catalogue discovery calls Sculpin's OpenAI `GET /v1/models` to
 * enumerate upstream agents. It needs an upstream target + a Sculpin credential,
 * but that credential is DELIBERATELY SEPARATE from the data-plane's
 * `SCULPIN_UPSTREAM_API_KEY` (a distinct, least-privilege `SCULPIN_DISCOVERY_API_KEY`).
 * S7 completes the broader web/data-plane secret split; this slice establishes
 * the discovery seam so the web control plane never has to hold the proxy's
 * request-serving key.
 *
 * Like the data-plane config, `sculpinUpstreamUrl` is DEPLOYMENT configuration
 * only — never sourced from a request, catalogue record, admin form, or PAT
 * (SSRF / credential boundary). Neither the URL nor the key is ever returned to
 * clients, logged, or persisted.
 */
export interface DiscoveryConfig {
  sculpinUpstreamUrl: string;
  sculpinDiscoveryApiKey: string;
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

/**
 * Resolve the TEST-ONLY E2E auth seam flags. Fails closed:
 *  - `E2E_TEST_AUTH === "1"` together with `NODE_ENV === "production"` is a HARD
 *    error — this runs for EVERY web process, so a production deployment that
 *    accidentally carries the flag fails startup rather than exposing the seam.
 *  - When enabled, `E2E_SESSION_SEED_KEY` is REQUIRED and must be >= 32 chars.
 *  - Any value other than exactly `"1"` disables the seam entirely; the seed key
 *    is then ignored and returned as `undefined`.
 */
function resolveE2EAuth(
  environment: RuntimeEnvironment,
  input: NodeJS.ProcessEnv,
): { e2eTestAuth: boolean; e2eSessionSeedKey?: string } {
  const e2eTestAuth = input.E2E_TEST_AUTH === "1";
  if (!e2eTestAuth) {
    return { e2eTestAuth: false };
  }
  if (environment === "production") {
    throw new Error(
      "Invalid runtime configuration. E2E_TEST_AUTH must never be enabled in production.",
    );
  }
  const seedKey = input.E2E_SESSION_SEED_KEY;
  if (typeof seedKey !== "string" || seedKey.length < 32) {
    throw new Error(
      "Invalid runtime configuration. Check: E2E_SESSION_SEED_KEY (required, >= 32 characters, when E2E_TEST_AUTH=1).",
    );
  }
  return { e2eTestAuth: true, e2eSessionSeedKey: seedKey };
}

export function parseWebAuthConfig(input: NodeJS.ProcessEnv): AuthConfig {
  const environment = parse(
    baseSchema.pick({ NODE_ENV: true }),
    input,
  ).NODE_ENV;
  const value = parse(authSchema, input);
  assertProductionAuthUrlSafety(environment, value.BETTER_AUTH_URL);
  const e2e = resolveE2EAuth(environment, input);
  return {
    betterAuthSecret: value.BETTER_AUTH_SECRET,
    betterAuthUrl: value.BETTER_AUTH_URL,
    googleClientId: value.GOOGLE_CLIENT_ID,
    googleClientSecret: value.GOOGLE_CLIENT_SECRET,
    githubClientId: value.GITHUB_CLIENT_ID,
    githubClientSecret: value.GITHUB_CLIENT_SECRET,
    bootstrapAdminEmails: value.BOOTSTRAP_ADMIN_EMAILS,
    ...e2e,
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

// The PAT-hashing env slice, shared by the least-privilege web `parsePatConfig`
// and the broader `parseDataPlaneConfig`. Deliberately carries NO upstream URL
// or upstream credential — a control plane that only mints/verifies PATs must
// not be forced to hold the data plane's request-serving Sculpin key.
const patHashSchema = z.object({
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

// Build the rotation-aware keyring from the parsed PAT-hash env. Sets retired
// keys first, then the CURRENT key last so it is authoritative for its version.
// A retired entry that names the CURRENT version is a collision — fail closed
// rather than silently overriding.
function buildPatConfig(value: z.infer<typeof patHashSchema>): PatConfig {
  const currentVersion = value.PAT_HASH_KEY_VERSION;
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
    patHashSecret: value.PAT_HASH_SECRET,
    patHashKeyring: { currentVersion, keys },
  };
}

/**
 * Parse and validate ONLY the PAT-hashing configuration (least privilege for the
 * web control plane). Fails closed with a secret-safe, field-name-only error.
 * Deliberately does NOT require `SCULPIN_UPSTREAM_URL` or
 * `SCULPIN_UPSTREAM_API_KEY`: minting/verifying PATs must never force the web app
 * to hold the data plane's upstream Sculpin credential.
 */
export function parsePatConfig(input: NodeJS.ProcessEnv): PatConfig {
  return buildPatConfig(parse(patHashSchema, input));
}

const dataPlaneSchema = patHashSchema.extend({
  NODE_ENV: environmentSchema.default("development"),
  // The canonical, public Hub origin used to render connection instructions
  // (never derived from a request Host header).
  HUB_PUBLIC_URL: httpUrl,
  // Deployment-only upstream target. Never sourced from a request/catalogue/PAT.
  SCULPIN_UPSTREAM_URL: httpUrl,
  // Server secret the Hub sends to Sculpin as `Authorization: Bearer ...`.
  SCULPIN_UPSTREAM_API_KEY: z.string().min(1).max(4096),
  // Bounded time (ms) the proxy waits for the upstream to return RESPONSE
  // HEADERS before failing closed. Disarmed once headers arrive so long SSE
  // streams are never cut off (see D-022).
  SCULPIN_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
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
  return {
    hubPublicUrl: value.HUB_PUBLIC_URL,
    sculpinUpstreamUrl: value.SCULPIN_UPSTREAM_URL,
    sculpinUpstreamApiKey: value.SCULPIN_UPSTREAM_API_KEY,
    upstreamTimeoutMs: value.SCULPIN_UPSTREAM_TIMEOUT_MS,
    ...buildPatConfig(value),
  };
}
const discoverySchema = z.object({
  // Deployment-only upstream target — same source of truth as the data plane's
  // `SCULPIN_UPSTREAM_URL`. Never sourced from a request/catalogue/PAT (no SSRF).
  SCULPIN_UPSTREAM_URL: httpUrl,
  // Least-privilege Sculpin credential used ONLY for admin-side discovery. Kept
  // separate from `SCULPIN_UPSTREAM_API_KEY` (S7 finishes the broader split).
  // Never stored in the DB, returned to clients, logged, or in usage events.
  SCULPIN_DISCOVERY_API_KEY: z.string().min(1).max(4096),
});

/**
 * Parse and validate the admin-only Sculpin discovery configuration. Fails
 * closed with a field-name-only, secret-safe error. Isolated from the web PAT /
 * auth config so the web control plane does not require a Sculpin key unless it
 * actually performs discovery.
 */
export function parseDiscoveryConfig(input: NodeJS.ProcessEnv): DiscoveryConfig {
  const value = parse(discoverySchema, input);
  return {
    sculpinUpstreamUrl: value.SCULPIN_UPSTREAM_URL,
    sculpinDiscoveryApiKey: value.SCULPIN_DISCOVERY_API_KEY,
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
