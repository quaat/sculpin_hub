import { Pool, type PoolConfig } from "pg";
export interface Database {
  readonly pool: Pool;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
export function createDatabase(
  connectionString: string,
  overrides: Omit<PoolConfig, "connectionString"> = {},
): Database {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    ...overrides,
  });
  return {
    pool,
    async ready() {
      const result = await pool.query<{ ready: number }>("SELECT 1 AS ready");
      return result.rows[0]?.ready === 1;
    },
    async close() {
      await pool.end();
    },
  };
}
let singleton: Database | undefined;
export function getDatabase(connectionString: string): Database {
  singleton ??= createDatabase(connectionString);
  return singleton;
}
export async function closeDatabase(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = undefined;
  }
}
