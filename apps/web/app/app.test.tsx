import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "./page";
import Products from "./products/page";
import Pricing from "./pricing/page";
import Dashboard from "./dashboard/page";
describe("public pages", () => {
  it.each([
    ["home", <HomePage />],
    ["products", <Products />],
    ["pricing", <Pricing />],
    ["dashboard", <Dashboard />],
  ])("renders the %s page", (_name, page) => {
    expect(renderToStaticMarkup(page)).toContain("<main");
  });
  it("uses semantic landing-page structure and explicit preview language", () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toMatch(/<main[^>]*id="main"/);
    expect(html).toMatch(/<h1>/);
    expect(html).toMatch(/<section/);
    expect(html).toMatch(/Presentation preview only/);
    expect(html).not.toMatch(/Sign in|Checkout now/);
  });
  it("does not imply dashboard authentication", () => {
    expect(renderToStaticMarkup(<Dashboard />)).toContain(
      "does not indicate that you are signed in",
    );
  });
});
