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
export type OpenAiError = z.infer<typeof openAiErrorSchema>;
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
