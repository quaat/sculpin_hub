import { NextResponse } from "next/server";
import { readinessResponseSchema } from "@sculpin/api-contracts";
import { parseWebConfig } from "@sculpin/config";
import { getDatabase, type Database } from "@sculpin/db";
import { createLogger } from "@sculpin/observability";
type DatabaseFactory = (url: string) => Database;
const logger = createLogger({
  service: "web",
  environment: process.env.NODE_ENV ?? "development",
  level: process.env.LOG_LEVEL ?? "info",
});
export function createReadinessHandler(
  environment: NodeJS.ProcessEnv,
  factory: DatabaseFactory,
) {
  return async function readiness(): Promise<NextResponse> {
    try {
      const config = parseWebConfig(environment);
      const database = factory(config.databaseUrl);
      const ready = await database.ready();
      const body = readinessResponseSchema.parse({
        status: ready ? "ready" : "not_ready",
        service: "web",
        dependencies: { database: ready ? "up" : "down" },
      });
      return NextResponse.json(body, { status: ready ? 200 : 503 });
    } catch (error) {
      logger.warn({ err: error }, "web readiness dependency failed");
      const body = readinessResponseSchema.parse({
        status: "not_ready",
        service: "web",
        dependencies: { database: "down" },
      });
      return NextResponse.json(body, { status: 503 });
    }
  };
}
export const GET = createReadinessHandler(process.env, getDatabase);
