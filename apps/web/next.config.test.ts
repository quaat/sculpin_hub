import { describe, expect, it } from "vitest";
import { browserSecurityHeaders } from "./next.config.js";
const headers = Object.fromEntries(
  browserSecurityHeaders().map(({ key, value }) => [key, value]),
);
describe("browser security headers", () => {
  it("sets the portable safe baseline", () => {
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
  it("delegates HSTS to the TLS edge", () =>
    expect(headers["Strict-Transport-Security"]).toBeUndefined());
});
