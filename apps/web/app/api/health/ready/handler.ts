import { NextResponse } from "next/server";
import { readinessResponseSchema } from "@sculpin/api-contracts";
import { parseWebConfig } from "@sculpin/config";
import type { Database } from "@sculpin/db";
import type { Logger } from "@sculpin/observability";

type DatabaseFactory = (url: string) => Database;
export function createReadinessHandler(
  environment: NodeJS.ProcessEnv,
  factory: DatabaseFactory,
  logger: Pick<Logger, "warn">,
) {
  return async function readiness(): Promise<NextResponse> {
    try {
      const config = parseWebConfig(environment);
      const ready = await factory(config.databaseUrl).ready();
      const body = readinessResponseSchema.parse({
        status: ready ? "ready" : "not_ready",
        service: "web",
      });
      return NextResponse.json(body, {
        status: ready ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      logger.warn({ err: error }, "web readiness dependency failed");
      const body = readinessResponseSchema.parse({
        status: "not_ready",
        service: "web",
      });
      return NextResponse.json(body, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
  };
}
