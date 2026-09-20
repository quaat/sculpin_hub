import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import HomePage from "./page";
import Pricing from "./pricing/page";
import { ProductsView } from "./products/products-view";
describe("public pages", () => {
  it.each([
    ["home", <HomePage />],
    ["products", <ProductsView models={[]} />],
    ["pricing", <Pricing />],
  ])("renders the %s page", (_name, page) => {
    expect(renderToStaticMarkup(page)).toContain("<main");
  });
  it("uses semantic landing-page structure and honest live-status copy", () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toMatch(/<main[^>]*id="main"/);
    expect(html).toMatch(/<h1>/);
    expect(html).toMatch(/<section/);
    expect(html).toMatch(/governed Sculpin routing are live/);
    // The landing page does not host the sign-in control (that lives on
    // /dashboard) and makes no payment/checkout claim (no payments in v1).
    expect(html).not.toMatch(/Sign in|Checkout now/);
  });
  it("disables smooth scrolling for reduced-motion preferences", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*scroll-behavior:\s*auto/);
  });
});
