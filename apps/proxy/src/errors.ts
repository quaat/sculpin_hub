import {
  internalProxyError,
  proxyClientError,
  type OpenAiError,
} from "@sculpin/api-contracts";

export interface FrameworkError {
  readonly code?: string;
  readonly statusCode?: number;
  readonly validation?: unknown;
}
export interface MappedProxyError {
  readonly statusCode: 400 | 413 | 415 | 500;
  readonly body: OpenAiError;
}
export function mapProxyError(error: FrameworkError): MappedProxyError {
  if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY")
    return { statusCode: 400, body: proxyClientError("invalid_json") };
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE")
    return { statusCode: 413, body: proxyClientError("request_too_large") };
  if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE")
    return {
      statusCode: 415,
      body: proxyClientError("unsupported_media_type"),
    };
  if (error.validation !== undefined || error.statusCode === 400)
    return { statusCode: 400, body: proxyClientError("invalid_request") };
  return { statusCode: 500, body: internalProxyError() };
}
export function isV1Path(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/v1" || path === "/v1/" || path?.startsWith("/v1/") === true;
}
