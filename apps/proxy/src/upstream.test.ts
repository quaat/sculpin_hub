import { describe, expect, it, vi } from "vitest";
import {
  createSculpinUpstream,
  forwardableResponseHeaders,
  type FetchLike,
} from "./upstream.js";

const CONFIG = {
  sculpinUpstreamUrl: "http://internal-sculpin:8001",
  sculpinUpstreamApiKey: "sk-upstream-secret-xyz",
};

describe("upstream credential boundary", () => {
  it("injects the Hub bearer and never forwards caller auth, cookies, or PAT", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const upstream = createSculpinUpstream(CONFIG, fetchMock);
    const signal = new AbortController().signal;
    await upstream.chatCompletions(
      { model: "agent-1", messages: [{ role: "user", content: "hi" }] },
      {
        requestHeaders: {
          authorization: "Bearer sclp_pat_caller_secret",
          cookie: "session=abc",
          "proxy-authorization": "Basic xxx",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "x-random-header": "nope",
          "x-exodus-conversation-id": "conv-9",
          "x-agent-platform-include-metadata": "true",
        },
        signal,
      },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://internal-sculpin:8001/v1/chat/completions");
    const headers = init.headers as Headers;
    // Caller credential terminated; Hub credential injected here and nowhere else.
    expect(headers.get("authorization")).toBe("Bearer sk-upstream-secret-xyz");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    // Hop-by-hop and non-allowlisted headers are dropped.
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("transfer-encoding")).toBeNull();
    expect(headers.get("x-random-header")).toBeNull();
    // Conversation isolation (S11): NONE of the caller's headers cross upstream.
    // The conversation id and metadata opt-in are dropped, not forwarded, so the
    // caller can never supply a raw upstream conversation id.
    expect(headers.get("x-exodus-conversation-id")).toBeNull();
    expect(headers.get("x-agent-platform-include-metadata")).toBeNull();
    expect(init.body).toBe(
      JSON.stringify({
        model: "agent-1",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(init.signal).toBe(signal);
  });

  it("normalizes a trailing slash so the path is never doubled", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(new Response("{}"));
    const upstream = createSculpinUpstream(
      { ...CONFIG, sculpinUpstreamUrl: "http://x:8001/" },
      fetchMock,
    );
    await upstream.chatCompletions(
      {},
      { requestHeaders: {}, signal: new AbortController().signal },
    );
    expect(fetchMock.mock.calls[0]![0]).toBe("http://x:8001/v1/chat/completions");
  });

  it("never logs the upstream url or key", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      const fetchMock = vi.fn<FetchLike>().mockResolvedValue(new Response("{}"));
      const upstream = createSculpinUpstream(CONFIG, fetchMock);
      await upstream.chatCompletions(
        { model: "a", messages: [] },
        { requestHeaders: {}, signal: new AbortController().signal },
      );
      const logged = spies.flatMap((s) =>
        s.mock.calls.flat().map((a) => String(a)),
      );
      for (const line of logged) {
        expect(line).not.toContain(CONFIG.sculpinUpstreamApiKey);
        expect(line).not.toContain(CONFIG.sculpinUpstreamUrl);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("projects response headers onto the caller-safe allowlist", () => {
    const out = forwardableResponseHeaders(
      new Headers({
        "content-type": "text/event-stream",
        "x-exodus-conversation-id": "c1",
        "x-exodus-conversation-reused": "false",
        "x-exodus-conversation-source": "created",
        "set-cookie": "leak=1",
        server: "uvicorn",
        connection: "keep-alive",
        "x-internal-upstream": "sculpin",
      }),
    );
    // Conversation isolation (S11): only content-type is relayed; the upstream
    // x-exodus-conversation-* headers are dropped (fed in above to prove it).
    expect(out).toEqual({
      "content-type": "text/event-stream",
    });
  });
});
