import { TransformStream } from "node:stream/web";
import { upstreamUnavailableError } from "@sculpin/api-contracts";

/**
 * S9 alias rewrite (data plane). The proxy exposes a public model ALIAS to
 * clients but calls the upstream Sculpin service with an internal
 * `upstreamAgentId`. The internal id MUST NEVER leak back to callers, yet
 * Sculpin echoes it in the response body's protocol `model` field. These pure
 * helpers rewrite that field back to the caller-facing public alias — for both
 * the non-streaming JSON body and the incremental SSE stream.
 *
 * S7 fail-closed hardening: a success-path body (or SSE `data:` event) that is
 * not a well-formed JSON object is NEVER relayed verbatim. An unparseable /
 * mis-shaped body could carry the internal agent id, `exodus` metadata, a stack
 * trace, a database error, the upstream credential, or a vendor banner. On the
 * non-streaming path the caller signals this by returning `{ ok: false }` so the
 * data plane can substitute a sanitized gateway error; on the SSE path the
 * transform itself emits a sanitized error event and terminates the stream.
 */

/** Result of attempting to rewrite a non-streaming JSON body. */
export type JsonBodyRewrite =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false };

/**
 * Rewrite the protocol `model` field of a non-streaming OpenAI JSON response
 * body from the internal upstream id to the caller-facing public alias, and
 * strip the non-standard top-level `exodus` metadata block. Returns
 * `{ ok: false }` (fail closed) when the body is not a JSON object — the caller
 * must then substitute a sanitized gateway error rather than relay the body.
 */
export function rewriteModelInJsonBody(
  body: string,
  publicAlias: string,
): JsonBodyRewrite {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    // Not JSON: a well-formed chat-completion response is always a JSON object,
    // so an unparseable body is a gateway anomaly. Fail closed.
    return { ok: false };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false };
  const object = value as Record<string, unknown>;
  // S12 metadata-leak defense: Sculpin may attach a non-standard top-level
  // `exodus` metadata object; strip it so internal metadata never reaches the
  // client, even if the Hub never opted in.
  if (Object.prototype.hasOwnProperty.call(object, "exodus"))
    delete object.exodus;
  if (typeof object.model === "string") object.model = publicAlias;
  return { ok: true, body: JSON.stringify(object) };
}

/** Result of rewriting a single SSE event. */
type EventRewrite = { readonly ok: true; readonly text: string } | { readonly ok: false };

/** Split an SSE event into lines, tolerating both LF and CRLF line endings. */
function splitEventLines(event: string): string[] {
  return event.split(/\r\n|\n/);
}

/**
 * Rewrite a single SSE event (the text between event terminators) line by line.
 * Comment (keepalive) frames, blank lines, and non-`data:` fields pass through.
 * The terminal `data: [DONE]` sentinel and empty `data:` lines pass through.
 * A JSON `data:` payload has its `model` rewritten and any `exodus` block
 * stripped. A `data:` payload that is present but NOT a well-formed JSON object
 * fails closed (`{ ok: false }`) so the caller never forwards it verbatim.
 */
function rewriteEvent(event: string, publicAlias: string): EventRewrite {
  const out: string[] = [];
  for (const line of splitEventLines(event)) {
    if (!line.startsWith("data:")) {
      out.push(line);
      continue;
    }
    // Payload is everything after `data:`, with one optional leading space.
    const raw = line.slice("data:".length);
    const payload = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (payload === "" || payload === "[DONE]") {
      out.push(line);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return { ok: false };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return { ok: false };
    const object = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(object, "exodus"))
      delete object.exodus;
    if (typeof object.model === "string") object.model = publicAlias;
    out.push(`data: ${JSON.stringify(object)}`);
  }
  return { ok: true, text: out.join("\n") };
}

/** Earliest SSE event boundary in `buffer`, tolerating LF and CRLF framing. */
function findEventBoundary(
  buffer: string,
): { readonly index: number; readonly length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf))
    return { index: crlf, length: 4 };
  if (lf !== -1) return { index: lf, length: 2 };
  return undefined;
}

/**
 * Build an incremental SSE transform that rewrites ONLY the `model` field inside
 * JSON `data:` events to the public alias, preserving event framing, ordering,
 * comment (keepalive) frames, and the terminal `data: [DONE]` sentinel. It never
 * buffers the whole stream: it holds only the current partial event until its
 * terminator (`\n\n` or `\r\n\r\n`) arrives.
 *
 * S7 fail closed: if a `data:` event is present but not a well-formed JSON
 * object, the transform does NOT forward it. It emits a single sanitized
 * OpenAI-shaped error event followed by `data: [DONE]`, then stops forwarding:
 * every subsequent upstream byte is DROPPED (never buffered, never emitted) so a
 * malformed/hostile upstream frame can never leak a raw frame to the client. The
 * readable closes cleanly when the upstream body ends (the writable closes).
 */
export function createSseModelRewriteStream(
  publicAlias: string,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let failed = false;

  function failClosed(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    failed = true;
    buffer = ""; // never retain unforwarded upstream bytes
    controller.enqueue(
      encoder.encode(`data: ${JSON.stringify(upstreamUnavailableError())}\n\n`),
    );
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Once failed we drop everything: no decode, no buffering, no emit.
      if (failed) return;
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = findEventBoundary(buffer);
        if (!boundary) break;
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const result = rewriteEvent(event, publicAlias);
        if (!result.ok) return failClosed(controller);
        controller.enqueue(encoder.encode(result.text + "\n\n"));
      }
    },
    flush(controller) {
      if (failed) return;
      buffer += decoder.decode();
      if (buffer.length === 0) return;
      const result = rewriteEvent(buffer, publicAlias);
      if (!result.ok) return failClosed(controller);
      controller.enqueue(encoder.encode(result.text));
    },
  });
}
