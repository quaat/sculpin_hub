import { Pool, type PoolConfig } from "pg";
export interface Database {
  readonly pool: Pool;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
export interface DatabaseOptions extends Omit<PoolConfig, "connectionString"> {
  readinessTimeoutMs?: number;
  onPoolError?: (error: Error) => void;
}
export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): Database {
  const {
    readinessTimeoutMs = 2_000,
    onPoolError = () => undefined,
    ...poolOptions
  } = options;
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    ...poolOptions,
  });
  pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;
  return {
    pool,
    async ready() {
      const result = await pool.query<{ ready: number }>({
        text: "SELECT 1 AS ready",
        query_timeout: readinessTimeoutMs,
      });
      return result.rows[0]?.ready === 1;
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
let singleton: { connectionString: string; database: Database } | undefined;
export function getDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): Database {
  if (singleton && singleton.connectionString !== connectionString)
    throw new Error(
      "Database singleton is already configured for a different connection target.",
    );
  singleton ??= {
    connectionString,
    database: createDatabase(connectionString, options),
  };
  return singleton.database;
}
export async function closeDatabase(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  await current?.database.close();
}
