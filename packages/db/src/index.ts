import { Pool, type PoolConfig, type QueryConfig } from "pg";
export {
  PostgresOutboxJobStore,
  OutboxTransitionError,
  validateOutboxPayload,
} from "./outbox.js";
export {
  PostgresIdentityRepository,
  PostgresMembershipRepository,
  PostgresPersonalTenantTransaction,
} from "./tenant.js";

export interface PrismaClientLike {
  $disconnect(): Promise<void>;
}

async function createPrismaClient(
  connectionString: string,
): Promise<PrismaClientLike> {
  const loadPrisma = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<{
    PrismaClient: new (options: {
      datasources: { db: { url: string } };
    }) => PrismaClientLike;
  }>;
  const prisma = await loadPrisma("@prisma/client");
  return new prisma.PrismaClient({
    datasources: { db: { url: connectionString } },
  });
}

export interface Database {
  readonly pool: Pool;
  readonly prisma: PrismaClientLike;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
export interface DatabaseOptions extends Omit<PoolConfig, "connectionString"> {
  readinessTimeoutMs?: number;
  prismaClient?: PrismaClientLike;
  onPoolError?: (error: Error) => void;
}
export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): Database {
  const {
    readinessTimeoutMs = 2_000,
    prismaClient,
    onPoolError = () => undefined,
    max = 10,
    ...poolOptions
  } = options;
  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    ...poolOptions,
  });
  let prisma = prismaClient;
  let prismaPromise: Promise<PrismaClientLike> | undefined;
  pool.on("error", (error) => onPoolError(error));
  let closePromise: Promise<void> | undefined;
  return {
    pool,
    get prisma() {
      if (!prisma)
        throw new Error(
          "Prisma client is not initialized yet; call ready() before accessing it or inject prismaClient.",
        );
      return prisma;
    },
    async ready() {
      const readinessQuery: QueryConfig & { query_timeout: number } = {
        text: "SELECT 1 AS ready",
        query_timeout: readinessTimeoutMs,
      };
      prismaPromise ??= prisma
        ? Promise.resolve(prisma)
        : createPrismaClient(connectionString);
      prisma = await prismaPromise;
      const result = await pool.query<{ ready: number }>(readinessQuery);
      return result.rows[0]?.ready === 1;
    },
    close() {
      closePromise ??= Promise.all([
        pool.end(),
        prismaPromise?.then((client) => client.$disconnect()) ??
          prisma?.$disconnect() ??
          Promise.resolve(),
      ]).then(() => undefined);
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
