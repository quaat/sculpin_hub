import { describe, expect, it } from "vitest";
import {
  authenticationError,
  CATALOGUE_MODEL_OWNER,
  chatCompletionRequestSchema,
  insufficientQuotaError,
  internalProxyError,
  invalidRequestBodyError,
  modelListSchema,
  modelNotFoundError,
  noActiveSubscriptionError,
  openAiErrorSchema,
  requestIdSchema,
  proxyClientError,
  toModelList,
  unsupportedOperation,
  upstreamTimeoutError,
  upstreamUnavailableError,
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
  it("keeps every data-plane error OpenAI-shaped with a stable code", () => {
    const cases: [ReturnType<typeof authenticationError>, string][] = [
      [authenticationError(), "invalid_api_key"],
      [modelNotFoundError(), "model_not_found"],
      [noActiveSubscriptionError(), "no_active_subscription"],
      [insufficientQuotaError(), "insufficient_quota"],
      [upstreamUnavailableError(), "upstream_unavailable"],
      [upstreamTimeoutError(), "upstream_timeout"],
      [invalidRequestBodyError(), "invalid_request"],
    ];
    for (const [body, code] of cases) {
      expect(openAiErrorSchema.parse(body).error.code).toBe(code);
      // No internal detail leaks through any error surface.
      expect(JSON.stringify(body)).not.toMatch(/stack|sculpin|upstream:|http/i);
    }
  });
  it("validates chat completions request essentials and passes extra fields through", () => {
    const ok = chatCompletionRequestSchema.safeParse({
      model: "support",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      stream: true,
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.model).toBe("support");
      // Unknown sampling fields survive (passthrough) so upstream still sees them.
      expect((ok.data as { temperature?: number }).temperature).toBe(0.7);
    }
    expect(chatCompletionRequestSchema.safeParse({ messages: [] }).success).toBe(
      false,
    );
    expect(
      chatCompletionRequestSchema.safeParse({ model: "m", messages: [] })
        .success,
    ).toBe(false);
    expect(chatCompletionRequestSchema.safeParse({ model: "m" }).success).toBe(
      false,
    );
  });
});
