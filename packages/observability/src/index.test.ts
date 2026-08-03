import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { childLogger, createLogger } from "./index.js";
function capture() {
  let output = "";
  return {
    sink: new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
    read: () => output,
  };
}
describe("structured logging", () => {
  it("redacts credentials and supports correlation children", () => {
    const target = capture();
    const logger = childLogger(
      createLogger({ service: "test", environment: "test" }, target.sink),
      { requestId: "request-123" },
    );
    logger.info(
      {
        authorization: "Bearer canary-bearer",
        cookie: "session=canary-cookie",
        payload: {
          access_token: "canary-oauth",
          apiKey: "canary-api-key",
          upstreamCredential: "canary-upstream",
        },
      },
      "safe event",
    );
    const output = target.read();
    expect(output).toContain("request-123");
    expect(output).toContain("safe event");
    for (const secret of [
      "canary-bearer",
      "canary-cookie",
      "canary-oauth",
      "canary-api-key",
      "canary-upstream",
    ])
      expect(output).not.toContain(secret);
  });
  it("does not log a body unless a caller explicitly violates the logging contract", () => {
    const target = capture();
    createLogger({ service: "test", environment: "test" }, target.sink).info(
      { method: "GET" },
      "request",
    );
    expect(target.read()).not.toContain("body");
  });
  it("does not serialize exception messages or stacks", () => {
    const target = capture();
    createLogger({ service: "test", environment: "test" }, target.sink).error(
      { err: new Error("canary-exception-secret") },
      "failed safely",
    );
    expect(target.read()).not.toContain("canary-exception-secret");
  });
});
