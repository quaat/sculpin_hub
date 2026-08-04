import { getDatabase } from "@sculpin/db";
import { createLogger } from "@sculpin/observability";
import { createReadinessHandler } from "./handler";
const logger = createLogger({
  service: "web",
  environment: process.env.NODE_ENV ?? "development",
  level: process.env.LOG_LEVEL ?? "info",
});
export const GET = createReadinessHandler(
  process.env,
  (url) =>
    getDatabase(url, {
      onPoolError: (error) =>
        logger.error({ err: error }, "database pool error"),
    }),
  logger,
);
