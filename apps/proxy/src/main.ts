import { parseProxyConfig } from "@sculpin/config";
import { createProductionProxyServer } from "./server.js";
const config = parseProxyConfig(process.env);
const server = createProductionProxyServer(config);
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  server.log.info({ signal }, "graceful shutdown started");
  await server.close();
}
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
await server.listen({ port: config.port, host: config.host });
