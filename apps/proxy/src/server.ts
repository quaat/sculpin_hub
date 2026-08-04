import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { requestIdSchema, unsupportedOperation } from "@sculpin/api-contracts";
import type { ProxyConfig } from "@sculpin/config";
import { createDatabase, type Database } from "@sculpin/db";
import { createLogger } from "@sculpin/observability";
import { isV1Path, mapProxyError } from "./errors.js";
import {
  emptyProductionRouteRegistry,
  registerRoutes,
  type RouteRegistry,
} from "./registry.js";
export interface ServerDependencies {
  /** Injected databases remain caller-owned and are never closed by the server. */
  database?: Database;
  databaseFactory?: () => Database;
  registry: RouteRegistry;
}
export function createProxyServer(
  config: ProxyConfig,
  dependencies: ServerDependencies,
): FastifyInstance {
  const logger = createLogger({
    service: "proxy",
    environment: config.environment,
    level: config.logLevel,
  });
  const ownsDatabase = dependencies.database === undefined;
  const database =
    dependencies.database ??
    dependencies.databaseFactory?.() ??
    createDatabase(config.databaseUrl, {
      onPoolError: (error) =>
        logger.error({ err: error }, "database pool error"),
    });
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
    if (isV1Path(request.url) || request.url.startsWith("/health/"))
      _reply.header("cache-control", "no-store");
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
  server.get("/health/live", async () => ({ status: "ok", service: "proxy" }));
  server.get("/health/ready", async (_request, reply) => {
    try {
      if (await database.ready())
        return {
          status: "ready",
          service: "proxy",
        };
    } catch (error) {
      server.log.warn({ err: error }, "readiness dependency failed");
    }
    return reply.code(503).send({
      status: "not_ready",
      service: "proxy",
    });
  });
  registerRoutes(server, dependencies.registry);
  const unsupported = async (
    _request: unknown,
    reply: import("fastify").FastifyReply,
  ) => reply.code(404).send(unsupportedOperation());
  server.all("/v1", unsupported);
  server.all("/v1/", unsupported);
  server.all("/v1/*", unsupported);
  server.setErrorHandler((error, request, reply) => {
    const mapped = mapProxyError(error);
    const level = mapped.statusCode >= 500 ? "error" : "warn";
    request.log[level](
      { err: error, requestId: request.id, errorCode: mapped.body.error.code },
      "request failed",
    );
    if (isV1Path(request.url))
      void reply.code(mapped.statusCode).send(mapped.body);
    else
      void reply.code(mapped.statusCode).send({
        error: {
          code: mapped.body.error.code,
          message: mapped.body.error.message,
          requestId: request.id,
        },
      });
  });
  if (ownsDatabase) server.addHook("onClose", async () => database.close());
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
