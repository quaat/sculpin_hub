import { describe, expect, it } from "vitest";
import {
  CATALOGUE_MODEL_OWNER,
  internalProxyError,
  modelListSchema,
  openAiErrorSchema,
  requestIdSchema,
  proxyClientError,
  toModelList,
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
  it("creates safe categorized client errors", () => {
    expect(proxyClientError("request_too_large").error.code).toBe(
      "request_too_large",
    );
  });
  it("builds a valid OpenAI models list from public aliases", () => {
    const list = toModelList([
      { id: "sculpin-fast", created: 1_700_000_000 },
      { id: "sculpin-pro", created: 1_700_000_100 },
    ]);
    expect(modelListSchema.parse(list)).toEqual(list);
    expect(list.object).toBe("list");
    expect(list.data.map((m) => m.id)).toEqual(["sculpin-fast", "sculpin-pro"]);
    expect(list.data.every((m) => m.owned_by === CATALOGUE_MODEL_OWNER)).toBe(
      true,
    );
  });
  it("only serializes the alias id, never an upstream agent id", () => {
    const serialized = JSON.stringify(
      toModelList([{ id: "sculpin-fast", created: 1 }]),
    );
    expect(serialized).not.toMatch(/agent|upstream/i);
  });
});
