import { TransformStream } from "node:stream/web";

/**
 * S9 alias rewrite (data plane). The proxy exposes a public model ALIAS to
 * clients but calls the upstream Sculpin service with an internal
 * `upstreamAgentId`. The internal id MUST NEVER leak back to callers, yet
 * Sculpin echoes it in the response body's protocol `model` field. These pure
 * helpers rewrite that field back to the caller-facing public alias — for both
 * the non-streaming JSON body and the incremental SSE stream — without ever
 * throwing (a malformed body must never crash the response pipe).
 */

/**
 * Rewrite the protocol `model` field of a non-streaming OpenAI JSON response
 * body from the internal upstream id to the caller-facing public alias. If the
 * body is not a JSON object or has no string `model`, it is returned unchanged
 * (fail-open on shape, never throw) — the transform must never crash the pipe.
 */
export function rewriteModelInJsonBody(
  body: string,
  publicAlias: string,
): string {
  try {
    const value: unknown = JSON.parse(body);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { model?: unknown }).model === "string"
    ) {
      (value as { model: string }).model = publicAlias;
      return JSON.stringify(value);
    }
  } catch {
    // Not JSON (or otherwise unparseable): leave the body untouched.
  }
  return body;
}

/**
 * Rewrite a single SSE event (the text between `\n\n` terminators) line by
 * line, so comment (keepalive) frames, blank lines, and non-`data:` fields pass
 * through verbatim. Only JSON `data:` payloads with a string `model` are
 * rewritten; the terminal `data: [DONE]` sentinel and any unparseable payload
 * are preserved unchanged. Never throws.
 */
function rewriteEvent(event: string, publicAlias: string): string {
  return event
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      // Payload is everything after `data:`, with one optional leading space.
      const raw = line.slice("data:".length);
      const payload = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (payload === "[DONE]") return line;
      try {
        const value: unknown = JSON.parse(payload);
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          typeof (value as { model?: unknown }).model === "string"
        ) {
          (value as { model: string }).model = publicAlias;
          return `data: ${JSON.stringify(value)}`;
        }
      } catch {
        // Malformed JSON payload: keep the line verbatim.
      }
      return line;
    })
    .join("\n");
}

/**
 * Build an incremental SSE transform that rewrites ONLY the `model` field inside
 * JSON `data:` events to the public alias, preserving framing, ordering, comment
 * (keepalive) frames, and the terminal `data: [DONE]` sentinel. Never buffers the
 * whole stream: it holds only the current partial event until its `\n\n`
 * terminator arrives.
 */
export function createSseModelRewriteStream(
  publicAlias: string,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        controller.enqueue(
          encoder.encode(rewriteEvent(event, publicAlias) + "\n\n"),
        );
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0)
        controller.enqueue(encoder.encode(rewriteEvent(buffer, publicAlias)));
    },
  });
}
