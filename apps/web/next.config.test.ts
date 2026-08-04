import { describe, expect, it } from "vitest";
import { browserSecurityHeaders } from "./next.config.js";
const asRecord = (environment: string) =>
  Object.fromEntries(
    browserSecurityHeaders(environment).map(({ key, value }) => [key, value]),
  );
describe("browser security headers", () => {
  it("sets the safe baseline without development HSTS", () => {
    const headers = asRecord("development");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
  });
  it("enables HSTS only for production HTTPS deployment", () => {
    expect(asRecord("production")["Strict-Transport-Security"]).toContain(
      "max-age=31536000",
    );
  });
});
