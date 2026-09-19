import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
} from "fastify";
import type { Logger } from "pino";
import { requestIdSchema, unsupportedOperation } from "@sculpin/api-contracts";
import type { DataPlaneConfig, ProxyConfig } from "@sculpin/config";
import { createDatabase, type Database } from "@sculpin/db";
import { createLogger } from "@sculpin/observability";
import {
  createDataPlaneRouteRegistry,
  createDataPlaneServices,
} from "./data-plane.js";
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
  logger?: Logger;
}
export function trustedRequestId(
  header: string | readonly string[] | undefined,
  generate: () => string = randomUUID,
): string {
  return typeof header === "string" && requestIdSchema.safeParse(header).success
    ? header
    : generate();
}
export function createProxyServer(
  config: ProxyConfig,
  dependencies: ServerDependencies,
): FastifyInstance {
  // Widen to FastifyBaseLogger so the instance keeps the default
  // FastifyInstance typing instead of binding to pino's Logger type.
  const logger: FastifyBaseLogger =
    dependencies.logger ??
    createLogger({
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
    genReqId: (request) => trustedRequestId(request.headers["x-request-id"]),
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
  server.get("/health/live", () => ({ status: "ok", service: "proxy" }));
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
  // Fail closed: any /v1 path not explicitly registered above is never
  // forwarded. Registered routes (find-my-way static/param) take precedence
  // over these wildcards. There is no upstream passthrough — the secure data
  // plane injects credentials only for reviewed, registered routes (M6).
  const unsupportedV1 = (_request: unknown, reply: FastifyReply) =>
    reply.code(404).send(unsupportedOperation());
  server.all("/v1", unsupportedV1);
  server.all("/v1/", unsupportedV1);
  server.all("/v1/*", unsupportedV1);
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
  if (ownsDatabase) server.addHook("onClose", () => database.close());
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
/**
 * Production data plane (M6/M7): default-DENY registry populated by reviewed
 * code with EXACTLY `GET /v1/models` and `POST /v1/chat/completions`. The data
 * plane and the readiness probe share one database pool. The upstream URL/key
 * are consumed only inside the centralized upstream module.
 */
export function createSecureProductionProxyServer(
  config: ProxyConfig,
  dataPlaneConfig: DataPlaneConfig,
  database?: Database,
): FastifyInstance {
  const logger = createLogger({
    service: "proxy",
    environment: config.environment,
    level: config.logLevel,
  });
  const ownsDatabase = database === undefined;
  const db =
    database ??
    createDatabase(config.databaseUrl, {
      onPoolError: (error) => logger.error({ err: error }, "database pool error"),
    });
  const services = createDataPlaneServices(db.pool, dataPlaneConfig);
  const server = createProxyServer(config, {
    database: db,
    registry: createDataPlaneRouteRegistry(services),
    logger,
  });
  if (ownsDatabase) server.addHook("onClose", () => db.close());
  return server;
}
