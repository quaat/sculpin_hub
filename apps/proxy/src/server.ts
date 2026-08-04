import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import {
  internalProxyError,
  requestIdSchema,
  unsupportedOperation,
} from "@sculpin/api-contracts";
import type { ProxyConfig } from "@sculpin/config";
import { createDatabase, type Database } from "@sculpin/db";
import { createLogger } from "@sculpin/observability";
import {
  emptyProductionRouteRegistry,
  registerRoutes,
  type RouteRegistry,
} from "./registry.js";
export interface ServerDependencies {
  database?: Database;
  registry: RouteRegistry;
}
export function createProxyServer(
  config: ProxyConfig,
  dependencies: ServerDependencies,
): FastifyInstance {
  // Widen to FastifyBaseLogger so the instance keeps the default
  // FastifyInstance typing instead of binding to pino's Logger type.
  const logger: FastifyBaseLogger = createLogger({
    service: "proxy",
    environment: config.environment,
    level: config.logLevel,
  });
  const database = dependencies.database ?? createDatabase(config.databaseUrl);
  const server = Fastify({
    loggerInstance: logger,
    bodyLimit: config.bodyLimitBytes,
    requestIdHeader: "x-request-id",
    genReqId: (request) => {
      const candidate = request.headers["x-request-id"];
      return typeof candidate === "string" &&
        requestIdSchema.safeParse(candidate).success
        ? candidate
        : randomUUID();
    },
    disableRequestLogging: true,
  });
  server.addHook("onRequest", (request, _reply, done) => {
    _reply.header("x-request-id", request.id);
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.routeOptions.url,
      },
      "request received",
    );
    done();
  });
  server.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      { requestId: request.id, statusCode: reply.statusCode },
      "request completed",
    );
    done();
  });
  server.get("/health/live", () => ({ status: "ok", service: "proxy" }));
  server.get("/health/ready", async (_request, reply) => {
    try {
      if (await database.ready())
        return {
          status: "ready",
          service: "proxy",
          dependencies: { database: "up" },
        };
    } catch (error) {
      server.log.warn({ err: error }, "readiness dependency failed");
    }
    return reply.code(503).send({
      status: "not_ready",
      service: "proxy",
      dependencies: { database: "down" },
    });
  });
  registerRoutes(server, dependencies.registry);
  server.all("/v1/*", async (_request, reply) =>
    reply.code(404).send(unsupportedOperation()),
  );
  server.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, "request failed");
    void reply.code(500).send(internalProxyError());
  });
  server.addHook("onClose", async () => database.close());
  return server;
}
export function createProductionProxyServer(
  config: ProxyConfig,
  database?: Database,
): FastifyInstance {
  return createProxyServer(config, {
    registry: emptyProductionRouteRegistry(),
    ...(database ? { database } : {}),
  });
}
