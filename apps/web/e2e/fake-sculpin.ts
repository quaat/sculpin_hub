import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Deterministic FAKE Sculpin upstream for the browser E2E suite (CI only).
 *
 * This is a REAL HTTP server — Playwright boots it as its own `webServer` and
 * points the Next E2E process at it via `SCULPIN_UPSTREAM_URL`, so the app's
 * `discoverSculpinAgents()` adapter makes a genuine network round-trip over the
 * real credential-injecting code path. We do NOT mock `discoverSculpinAgents()`
 * itself; the only thing that is fake is the upstream on the other end of the
 * socket.
 *
 * Contract (mirrors docs/SCULPIN_INTEGRATION.md / D-020):
 *  - `GET /v1/models` requires `Authorization: Bearer <SCULPIN_DISCOVERY_API_KEY>`
 *    (401 otherwise) and returns a flat OpenAI model list. Each underlying agent
 *    appears TWICE — once by human slug and once by its STABLE uuid `id` — with
 *    `owned_by: "exodus"` and NO field linking the two, exactly as the real
 *    upstream does. This lets the suite exercise the UUID-only stable-alias rule.
 *  - `GET /health` is unauthenticated and returns 200 so Playwright's webServer
 *    readiness probe does not need the credential.
 *  - Every other route is 404. No external network is ever contacted.
 */

// STABLE (uuid-form) agent ids the admin journey can bind an alias to. Exported
// so the Playwright specs / seed can assert on the exact value without copying a
// literal. These are deterministic, not random, so tests are reproducible.
export const FAKE_STABLE_AGENT_ID = "2f1e6c7a-9b3d-4e51-8a0f-1c2d3e4f5a6b";
export const FAKE_SECONDARY_AGENT_ID = "7c3d9e21-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

interface ModelRow {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
}

// Two agents, each surfaced by slug AND uuid (no pairing field), plus a second
// stable agent — realistic for exercising filtering to uuid-form ids only.
const MODEL_ROWS: readonly ModelRow[] = [
  { id: "support", object: "model", created: 1_720_000_000, owned_by: "exodus" },
  { id: FAKE_STABLE_AGENT_ID, object: "model", created: 1_720_000_000, owned_by: "exodus" },
  { id: "research", object: "model", created: 1_720_000_100, owned_by: "exodus" },
  { id: FAKE_SECONDARY_AGENT_ID, object: "model", created: 1_720_000_100, owned_by: "exodus" },
];

function requireKey(): string {
  const key = process.env.SCULPIN_DISCOVERY_API_KEY;
  if (typeof key !== "string" || key.length < 8) {
    throw new Error(
      "fake-sculpin requires SCULPIN_DISCOVERY_API_KEY (>= 8 chars) in its env",
    );
  }
  return key;
}

function handle(req: IncomingMessage, res: ServerResponse, expectedKey: string): void {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  if (method === "GET" && url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (method === "GET" && (url === "/v1/models" || url.startsWith("/v1/models?"))) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${expectedKey}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unauthorized", type: "invalid_request_error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: MODEL_ROWS }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not_found", type: "invalid_request_error" } }));
}

function main(): void {
  const expectedKey = requireKey();
  const port = Number(process.env.SCULPIN_FAKE_PORT ?? "3211");
  const server = createServer((req, res) => {
    try {
      handle(req, res, expectedKey);
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal", type: "server_error" } }));
    }
  });
  server.listen(port, "127.0.0.1", () => {
    // A single ready line (no secrets) so CI logs show the bound port.
    process.stdout.write(`fake-sculpin listening on http://127.0.0.1:${port}\n`);
  });
}

// Only start the server when run as the entrypoint (Playwright's webServer).
// Spec files import the exported agent-id constants without booting a server.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
