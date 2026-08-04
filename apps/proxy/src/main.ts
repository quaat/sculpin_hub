import { parseProxyConfig } from "@sculpin/config";
import { createProductionProxyServer } from "./server.js";
import { createShutdownController } from "./shutdown.js";
const config = parseProxyConfig(process.env);
const server = createProductionProxyServer(config);
const shutdown = createShutdownController({
  shutdown: () => server.close(),
  timeoutMs: config.shutdownTimeoutMs,
  logger: server.log,
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
await server.listen({ port: config.port, host: config.host });
