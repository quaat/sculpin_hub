import { describe, expect, it } from "vitest";
import {
  createSseModelRewriteStream,
  rewriteModelInJsonBody,
} from "./rewrite.js";

describe("rewriteModelInJsonBody", () => {
  it("rewrites a top-level string model to the public alias", () => {
    const body = JSON.stringify({ id: "x", model: "agent-uuid", object: "o" });
    const out = rewriteModelInJsonBody(body, "support");
    expect(JSON.parse(out)).toEqual({ id: "x", model: "support", object: "o" });
  });

  it("leaves a body with no model field unchanged", () => {
    const body = JSON.stringify({ id: "x", object: "o" });
    expect(rewriteModelInJsonBody(body, "support")).toBe(body);
  });

  it("leaves invalid JSON unchanged (verbatim)", () => {
    const body = "not json at all {";
    expect(rewriteModelInJsonBody(body, "support")).toBe(body);
  });

  it("leaves a JSON array or primitive unchanged", () => {
    const array = JSON.stringify([{ model: "agent-uuid" }]);
    expect(rewriteModelInJsonBody(array, "support")).toBe(array);
    const primitive = JSON.stringify("agent-uuid");
    expect(rewriteModelInJsonBody(primitive, "support")).toBe(primitive);
  });

  it("leaves a non-string model unchanged", () => {
    const body = JSON.stringify({ id: "x", model: 42 });
    expect(rewriteModelInJsonBody(body, "support")).toBe(body);
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

  it("passes a keepalive comment frame through unchanged", async () => {
    const out = await runSse("support", [": keep-alive\n\n"]);
    expect(out).toBe(": keep-alive\n\n");
  });

  it("passes the terminal DONE sentinel through unchanged", async () => {
    const out = await runSse("support", ["data: [DONE]\n\n"]);
    expect(out).toBe("data: [DONE]\n\n");
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
});
