import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import type { PublicModel } from "@sculpin/domain";

// The per-agent Connect page is gated to PUBLISHED aliases: an unknown or
// unpublished alias must fail closed via `notFound()`, never render snippets.
// Mock the data + navigation seams so the gate is exercised without a DB.

class NotFoundError extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundError";
  }
}

const notFound = vi.fn(() => {
  throw new NotFoundError();
});
const listPublicModels = vi.fn<() => Promise<readonly PublicModel[]>>();

vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("../../lib/catalogue", () => ({
  listPublicModels: () => listPublicModels(),
}));
vi.mock("../../lib/public-hub-url", () => ({
  resolvePublicHubApiUrl: () => "https://hub.example.com/v1",
}));

import Connect from "./page";

const published: PublicModel = {
  id: "assistant-v1",
  displayName: "Assistant",
  description: "Helpful.",
};

beforeEach(() => {
  notFound.mockClear();
  listPublicModels.mockReset();
});

describe("connect page gate (per-agent)", () => {
  it("renders the connect view for a published alias", async () => {
    listPublicModels.mockResolvedValue([published]);
    const element = (await Connect({
      params: Promise.resolve({ alias: "assistant-v1" }),
    })) as ReactElement;
    const html = renderToStaticMarkup(element);
    expect(notFound).not.toHaveBeenCalled();
    expect(html).toContain("assistant-v1");
    expect(html).toContain("https://hub.example.com/v1/chat/completions");
  });

  it("404s an unknown / unpublished alias (fail closed)", async () => {
    listPublicModels.mockResolvedValue([published]);
    await expect(
      Connect({ params: Promise.resolve({ alias: "not-published" }) }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
