import { describe, expect, it } from "vitest";
import { isV1Path, mapProxyError } from "./errors.js";
describe("proxy error mapping", () => {
  it.each([
    ["FST_ERR_CTP_INVALID_JSON_BODY", 400, "invalid_json"],
    ["FST_ERR_CTP_BODY_TOO_LARGE", 413, "request_too_large"],
    ["FST_ERR_CTP_INVALID_MEDIA_TYPE", 415, "unsupported_media_type"],
  ] as const)("maps %s", (code, status, errorCode) => {
    const mapped = mapProxyError({ code });
    expect(mapped.statusCode).toBe(status);
    expect(mapped.body.error.code).toBe(errorCode);
  });
  it("maps validation separately from internal errors", () => {
    expect(mapProxyError({ validation: [] }).statusCode).toBe(400);
    expect(mapProxyError({}).statusCode).toBe(500);
  });
  it.each(["/v1", "/v1/", "/v1/models", "/v1/models?x=1"])(
    "recognizes %s",
    (path) => expect(isV1Path(path)).toBe(true),
  );
});
