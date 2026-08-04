import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HTTPMethods,
} from "fastify";
export interface SyntheticRoute {
  method: HTTPMethods;
  path: `/v1/${string}`;
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown;
}
export interface RouteRegistry {
  readonly routes: readonly SyntheticRoute[];
}
export function emptyProductionRouteRegistry(): RouteRegistry {
  return Object.freeze({ routes: Object.freeze([]) });
}
/** Test composition only. Never select routes from environment or client input. */
export function createTestRouteRegistry(
  routes: readonly SyntheticRoute[],
): RouteRegistry {
  return { routes: [...routes] };
}
export function registerRoutes(
  server: FastifyInstance,
  registry: RouteRegistry,
): void {
  for (const route of registry.routes)
    server.route({
      method: route.method,
      url: route.path,
      handler: route.handler,
    });
}
