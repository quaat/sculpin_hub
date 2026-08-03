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
  dependencies: z.record(z.string(), z.enum(["up", "down"])),
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
