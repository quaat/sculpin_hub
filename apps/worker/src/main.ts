import { parseWorkerConfig } from "@sculpin/config";
import { createDatabase } from "@sculpin/db";
import { createIdleJobRunner } from "@sculpin/jobs";
import { createLogger } from "@sculpin/observability";
import { WorkerRuntime } from "./runtime.js";
const config = parseWorkerConfig(process.env);
const logger = createLogger({
  service: "worker",
  environment: config.environment,
  level: config.logLevel,
});
const runtime = new WorkerRuntime(
  createDatabase(config.databaseUrl),
  createIdleJobRunner(),
  logger,
);
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => {
    logger.fatal("worker graceful shutdown timed out");
    process.exitCode = 1;
  }, config.shutdownTimeoutMs);
  timer.unref();
  await runtime.stop(signal);
  clearTimeout(timer);
}
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
await runtime.start();
