import { describe, expect, it } from "vitest";
import {
  internalProxyError,
  openAiErrorSchema,
  requestIdSchema,
  unsupportedOperation,
} from "./index.js";
describe("API contracts", () => {
  it("validates request IDs", () => {
    expect(requestIdSchema.safeParse("request_123").success).toBe(true);
    expect(requestIdSchema.safeParse("bad id").success).toBe(false);
  });
  it("keeps data-plane errors normalized and free of internals", () => {
    expect(openAiErrorSchema.parse(unsupportedOperation()).error.code).toBe(
      "unsupported_operation",
    );
    expect(JSON.stringify(internalProxyError())).not.toMatch(
      /stack|database|exception/i,
    );
  });
});
