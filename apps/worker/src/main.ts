import { parseWorkerConfig } from "@sculpin/config";
import { createDatabase } from "@sculpin/db";
import { createIdleJobRunner } from "@sculpin/jobs";
import { createLogger } from "@sculpin/observability";
import { WorkerRuntime } from "./runtime.js";
import { createShutdownController } from "./shutdown.js";
const config = parseWorkerConfig(process.env);
const logger = createLogger({
  service: "worker",
  environment: config.environment,
  level: config.logLevel,
});
const runtime = new WorkerRuntime(
  createDatabase(config.databaseUrl, {
    onPoolError: (error) => logger.error({ err: error }, "database pool error"),
  }),
  createIdleJobRunner(),
  logger,
);
let resolveStopped: () => void = () => undefined;
const stopped = new Promise<void>((resolve) => {
  resolveStopped = resolve;
});
const shutdown = createShutdownController({
  shutdown: async () => {
    await runtime.stop("process signal");
    resolveStopped();
  },
  timeoutMs: config.shutdownTimeoutMs,
  logger,
  exit: (code) => process.exit(code),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
await runtime.start();
await stopped;
