import { describe, expect, it } from "vitest";
import {
  createSseModelRewriteStream,
  rewriteModelInJsonBody,
} from "./rewrite.js";

function okBody(body: string, alias: string): string {
  const result = rewriteModelInJsonBody(body, alias);
  if (!result.ok) throw new Error("expected ok rewrite");
  return result.body;
}

describe("rewriteModelInJsonBody", () => {
  it("rewrites a top-level string model to the public alias", () => {
    const body = JSON.stringify({ id: "x", model: "agent-uuid", object: "o" });
    expect(JSON.parse(okBody(body, "support"))).toEqual({
      id: "x",
      model: "support",
      object: "o",
    });
  });

  it("leaves a body with no model field unchanged (still ok)", () => {
    const body = JSON.stringify({ id: "x", object: "o" });
    expect(JSON.parse(okBody(body, "support"))).toEqual({
      id: "x",
      object: "o",
    });
  });

  it("fails closed on invalid JSON (never relayed verbatim)", () => {
    expect(rewriteModelInJsonBody("not json at all {", "support")).toEqual({
      ok: false,
    });
  });

  it("fails closed on a JSON array or primitive", () => {
    // A well-formed chat completion is always a JSON object; anything else is a
    // gateway anomaly and must not be relayed.
    expect(
      rewriteModelInJsonBody(JSON.stringify([{ model: "agent-uuid" }]), "support"),
    ).toEqual({ ok: false });
    expect(
      rewriteModelInJsonBody(JSON.stringify("agent-uuid"), "support"),
    ).toEqual({ ok: false });
  });

  it("leaves a non-string model unchanged (object still re-serialized)", () => {
    const body = JSON.stringify({ id: "x", model: 42 });
    expect(JSON.parse(okBody(body, "support"))).toEqual({ id: "x", model: 42 });
  });

  it("strips a top-level exodus block while rewriting the model", () => {
    const body = JSON.stringify({
      id: "x",
      model: "agent-uuid",
      exodus: { conversation_id: "internal" },
    });
    const out = okBody(body, "support");
    expect(JSON.parse(out)).toEqual({ id: "x", model: "support" });
    expect(out).not.toContain("exodus");
    expect(out).not.toContain("internal");
  });

  it("strips a top-level exodus block even without a model field", () => {
    const body = JSON.stringify({
      id: "x",
      exodus: { conversation_id: "internal" },
    });
    const out = okBody(body, "support");
    expect(JSON.parse(out)).toEqual({ id: "x" });
    expect(out).not.toContain("exodus");
  });
});

async function runSse(alias: string, chunks: string[]): Promise<string> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ts = createSseModelRewriteStream(alias);
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  let out = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
  })();
  for (const c of chunks) await writer.write(enc.encode(c));
  await writer.close();
  await pump;
  return out;
}

describe("createSseModelRewriteStream", () => {
  it("rewrites the model field inside a data event, preserving framing", async () => {
    const event = `data: {"id":"c","model":"agent-uuid","choices":[]}\n\n`;
    const out = await runSse("support", [event]);
    expect(out).toContain(`"model":"support"`);
    expect(out).not.toContain("agent-uuid");
    expect(out.endsWith("\n\n")).toBe(true);
    // Round-trips as a single valid event.
    const payload = out.slice("data: ".length, out.indexOf("\n\n"));
    expect(JSON.parse(payload)).toMatchObject({ id: "c", model: "support" });
  });

  it("strips an exodus block from a JSON data event, keeping DONE/keepalive verbatim", async () => {
    const chunks = [
      `data: {"id":"c","model":"agent-uuid","exodus":{"conversation_id":"internal"}}\n\n`,
      ": keep-alive\n\n",
      "data: [DONE]\n\n",
    ];
    const out = await runSse("support", chunks);
    expect(out).not.toContain("exodus");
    expect(out).not.toContain("internal");
    expect(out).toContain(`"model":"support"`);
    expect(out).not.toContain("agent-uuid");
    // Non-JSON frames are still forwarded byte-for-byte.
    expect(out).toContain(": keep-alive\n\n");
    expect(out).toContain("data: [DONE]\n\n");
  });

  it("passes a keepalive comment frame through unchanged", async () => {
    const out = await runSse("support", [": keep-alive\n\n"]);
    expect(out).toBe(": keep-alive\n\n");
  });

  it("passes the terminal DONE sentinel through unchanged", async () => {
    const out = await runSse("support", ["data: [DONE]\n\n"]);
    expect(out).toBe("data: [DONE]\n\n");
  });

  it("emits a completed event BEFORE the final event is written (incremental, no whole-stream buffering)", async () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const ts = createSseModelRewriteStream("support");
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    // Write only the FIRST frame, then read it back — proving the transform does
    // not wait for the terminal frame before emitting completed events. The
    // write is not awaited before the read because a web TransformStream applies
    // backpressure (HWM) until the reader pulls; the pull below relieves it.
    const firstWrite = writer.write(
      enc.encode(`data: {"seq":1,"model":"agent-uuid"}\n\n`),
    );
    const first = await reader.read();
    await firstWrite;
    expect(first.done).toBe(false);
    const firstText = dec.decode(first.value);
    expect(firstText).toContain(`"seq":1`);
    expect(firstText).toContain(`"model":"support"`);
    expect(firstText).not.toContain("agent-uuid");
    // Only now is the final frame written and the stream closed. Drain the
    // reader concurrently so backpressure (HWM) on these writes is relieved.
    const writeRest = (async () => {
      await writer.write(enc.encode("data: [DONE]\n\n"));
      await writer.close();
    })();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
    }
    await writeRest;
    expect(rest).toContain("data: [DONE]");
  });

  it("rewrites an event split across two chunks and emits it once", async () => {
    const first = `data: {"id":"c","model":"agent-`;
    const second = `uuid","choices":[]}\n\n`;
    const out = await runSse("support", [first, second]);
    expect(out).toContain(`"model":"support"`);
    expect(out).not.toContain("agent-uuid");
    // Exactly one event terminator: the event was emitted once, not prematurely.
    expect(out.split("\n\n").filter((s) => s.length > 0)).toHaveLength(1);
  });

  it("preserves the ordering of multiple events", async () => {
    const chunks = [
      `data: {"seq":1,"model":"agent-uuid"}\n\n`,
      ": keep-alive\n\n",
      `data: {"seq":2,"model":"agent-uuid"}\n\n`,
      "data: [DONE]\n\n",
    ];
    const out = await runSse("support", chunks);
    const seq1 = out.indexOf(`"seq":1`);
    const keep = out.indexOf(": keep-alive");
    const seq2 = out.indexOf(`"seq":2`);
    const done = out.indexOf("[DONE]");
    expect(seq1).toBeGreaterThanOrEqual(0);
    expect(seq1).toBeLessThan(keep);
    expect(keep).toBeLessThan(seq2);
    expect(seq2).toBeLessThan(done);
    expect(out).not.toContain("agent-uuid");
  });

  it("parses CRLF (\\r\\n\\r\\n) event framing that Sculpin may emit", async () => {
    const chunks = [
      `data: {"id":"c","model":"agent-uuid","choices":[]}\r\n\r\n`,
      ": keep-alive\r\n\r\n",
      "data: [DONE]\r\n\r\n",
    ];
    const out = await runSse("support", chunks);
    expect(out).toContain(`"model":"support"`);
    expect(out).not.toContain("agent-uuid");
    expect(out).toContain("data: [DONE]");
    // The keepalive comment frame survives (its text is preserved).
    expect(out).toContain(": keep-alive");
  });

  it("parses a CRLF boundary split across two chunks", async () => {
    const chunks = [
      `data: {"id":"c","model":"agent-uuid","choices":[]}\r\n`,
      `\r\ndata: [DONE]\r\n\r\n`,
    ];
    const out = await runSse("support", chunks);
    expect(out).toContain(`"model":"support"`);
    expect(out).not.toContain("agent-uuid");
    expect(out).toContain("data: [DONE]");
  });

  it("fails closed on a malformed data event: sanitized error + DONE, no leak", async () => {
    const chunks = [
      // A first valid frame is forwarded, THEN a malformed data payload that
      // could smuggle an internal id must NOT be forwarded verbatim.
      `data: {"id":"c","model":"agent-uuid","choices":[]}\n\n`,
      `data: {"model":"agent-uuid-LEAK", broken json :(\n\n`,
      `data: {"id":"c2","model":"agent-uuid","choices":[]}\n\n`,
      "data: [DONE]\n\n",
    ];
    const out = await runSse("support", chunks);
    // First valid frame passed through with the alias.
    expect(out).toContain(`"model":"support"`);
    // The malformed frame (and everything after it) never reaches the client.
    expect(out).not.toContain("agent-uuid");
    expect(out).not.toContain("LEAK");
    expect(out).not.toContain("broken json");
    expect(out).not.toContain(`"id":"c2"`);
    // A sanitized OpenAI-shaped error is emitted, then the stream terminates.
    expect(out).toContain("upstream_unavailable");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("fails closed on a data event that is a JSON array (not an object)", async () => {
    const chunks = [`data: [1,2,3]\n\n`, "data: [DONE]\n\n"];
    const out = await runSse("support", chunks);
    expect(out).not.toContain("[1,2,3]");
    expect(out).toContain("upstream_unavailable");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
