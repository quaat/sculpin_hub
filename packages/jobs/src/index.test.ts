import { describe, expect, it } from "vitest";
import { createIdleJobRunner } from "./index.js";
describe("job foundation", () => {
  it("does not poll when no handlers are registered", async () => {
    const runner = createIdleJobRunner();
    expect(runner.handlerCount).toBe(0);
    expect(await runner.runOnce(new AbortController().signal)).toBe(0);
  });
});
