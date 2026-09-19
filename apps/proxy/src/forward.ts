import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { FastifyReply, FastifyRequest } from "fastify";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function forwardableHeaders(
  headers: FastifyRequest["headers"],
  requestId: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  result["x-request-id"] = requestId;
  return result;
}

export function createForwardHandler(upstreamUrl: string) {
  const base = upstreamUrl.replace(/\/+$/, "");
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body =
      request.body === undefined || request.body === null
        ? undefined
        : typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body);
    const upstream = await fetch(`${base}${request.url}`, {
      method: request.method,
      headers: forwardableHeaders(request.headers, request.id),
      ...(body === undefined ? {} : { body }),
    });
    reply.code(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) reply.header(key, value);
    });
    reply.header("x-request-id", request.id);
    if (upstream.body === null) return reply.send();
    return reply.send(Readable.fromWeb(upstream.body as WebReadableStream));
  };
}
