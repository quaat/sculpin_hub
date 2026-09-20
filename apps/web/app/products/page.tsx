import type { Metadata } from "next";
import { listPublicModels } from "../lib/catalogue";
import { ProductsView } from "./products-view";

export const metadata: Metadata = { title: "Products" };

// The published catalogue is read fresh from the DB on every request.
export const dynamic = "force-dynamic";

export default async function Products() {
  // Public (not auth-gated): exposes only the client-safe `PublicModel`
  // projection (alias/displayName/description) — never the upstream agent id.
  const models = await listPublicModels();
  return <ProductsView models={models} />;
}
