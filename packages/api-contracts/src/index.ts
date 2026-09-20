import { z } from "zod";
export const requestIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
});
export const readinessResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  service: z.string().min(1),
  dependencies: z.record(z.string(), z.enum(["up", "down"])).optional(),
});
export const controlPlaneErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: requestIdSchema,
  }),
});
// OpenAI-compatible `GET /v1/models` surface. `id` is the Hub's public model
// alias; the upstream Sculpin agent id is NEVER part of this contract.
export const modelObjectSchema = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string().min(1),
});
export const modelListSchema = z.object({
  object: z.literal("list"),
  data: z.array(modelObjectSchema),
});
export const openAiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable(),
    code: z.string(),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type ModelObject = z.infer<typeof modelObjectSchema>;
export type ModelList = z.infer<typeof modelListSchema>;
export type OpenAiError = z.infer<typeof openAiErrorSchema>;

export const CATALOGUE_MODEL_OWNER = "sculpin-hub";

/**
 * Build the OpenAI `GET /v1/models` list body from the Hub's public model
 * aliases. Only the alias (`id`) is exposed; the upstream agent id is not part
 * of the input type, so it cannot be serialized here.
 */
export function toModelList(
  models: readonly { id: string; created: number }[],
): ModelList {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: model.created,
      owned_by: CATALOGUE_MODEL_OWNER,
    })),
  };
}
export function unsupportedOperation(): OpenAiError {
  return {
    error: {
      message: "The requested API operation is not available.",
      type: "invalid_request_error",
      param: null,
      code: "unsupported_operation",
    },
  };
}
export function internalProxyError(): OpenAiError {
  return {
    error: {
      message: "The request could not be completed.",
      type: "api_error",
      param: null,
      code: "internal_error",
    },
  };
}
export type ProxyClientErrorCode =
  | "invalid_json"
  | "invalid_request"
  | "request_too_large"
  | "unsupported_media_type";
export function proxyClientError(code: ProxyClientErrorCode): OpenAiError {
  const messages: Record<ProxyClientErrorCode, string> = {
    invalid_json: "The request body is not valid JSON.",
    invalid_request: "The request input is invalid.",
    request_too_large: "The request body exceeds the allowed size.",
    unsupported_media_type: "The request media type is not supported.",
  };
  return {
    error: {
      message: messages[code],
      type: "invalid_request_error",
      param: null,
      code,
    },
  };
}
// Data-plane (M6) OpenAI-shaped errors. Every failure returns a single opaque
// body: no reason leaks the caller's identity, the entitlement state, or any
// upstream detail beyond the OpenAI-standard code. The internal Sculpin URL and
// upstream credential NEVER appear in any of these shapes.
export function authenticationError(): OpenAiError {
  return {
    error: {
      message: "The provided API key is invalid, revoked, or expired.",
      type: "invalid_request_error",
      param: null,
      code: "invalid_api_key",
    },
  };
}
export function modelNotFoundError(): OpenAiError {
  return {
    error: {
      message: "The requested model does not exist or is not available.",
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  };
}
export function noActiveSubscriptionError(): OpenAiError {
  return {
    error: {
      message: "An active subscription is required to use this API.",
      type: "invalid_request_error",
      param: null,
      code: "no_active_subscription",
    },
  };
}
export function insufficientQuotaError(): OpenAiError {
  return {
    error: {
      message: "You have exceeded your current request quota.",
      type: "insufficient_quota",
      param: null,
      code: "insufficient_quota",
    },
  };
}
export function upstreamUnavailableError(): OpenAiError {
  return {
    error: {
      message: "The upstream service is temporarily unavailable.",
      type: "api_error",
      param: null,
      code: "upstream_unavailable",
    },
  };
}
export function upstreamTimeoutError(): OpenAiError {
  return {
    error: {
      message: "The upstream service did not respond in time.",
      type: "api_error",
      param: null,
      code: "upstream_timeout",
    },
  };
}
export function invalidRequestBodyError(): OpenAiError {
  return {
    error: {
      message: "The request must include a model and at least one message.",
      type: "invalid_request_error",
      param: null,
      code: "invalid_request",
    },
  };
}
// Minimal validation of the OpenAI chat-completions request. Only the fields the
// Hub needs are constrained (`model`, `messages`, `stream`); all other fields
// pass through untouched so upstream sampling controls still reach Sculpin.
export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    messages: z.array(z.unknown()).min(1),
    stream: z.boolean().optional(),
  })
  .passthrough();
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
