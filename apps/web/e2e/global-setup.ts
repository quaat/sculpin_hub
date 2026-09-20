import { randomUUID } from "node:crypto";
import {
  createDatabase,
  PostgresCatalogueRepository,
  PostgresPlanRepository,
} from "@sculpin/db";
import {
  personalOrganizationSlug,
  provisionPersonalTenant,
} from "../app/lib/provisioning";
import { FAKE_SECONDARY_AGENT_ID } from "./fake-sculpin";

/**
 * S15 E2E global setup (SERVER-SIDE only — has DB + secret access).
 *
 * Seeds deterministic personas and catalogue/plan rows using the REAL services
 * and repositories so authorization below the auth boundary is never faked:
 *  - Persona users are INSERTed into the canonical `users` table, then their
 *    personal tenant is provisioned via the REAL `provisionPersonalTenant`
 *    transaction (org + owner membership + audit + outbox), exactly as the OAuth
 *    sign-up path does.
 *  - A published catalogue entry + a self-service plan (attached to that entry)
 *    are seeded via `PostgresCatalogueRepository` / `PostgresPlanRepository` so
 *    the USER catalogue and claim journeys have real, entitled data.
 *
 * Sessions are NOT minted here — each test mints its own via the seam endpoint
 * (`fixtures.ts`). Sculpin discovery is NOT mocked: a deterministic fake Sculpin
 * HTTP server (`e2e/fake-sculpin.ts`) runs as its own Playwright `webServer`, and
 * the Next process reaches it over the real discovery adapter — so no live
 * Sculpin call is made, but the real credential-injecting code path is exercised.
 * The seeded offering binds to a stable agent id the fake server actually serves,
 * so admin drift detection sees no drift.
 *
 * The ADMIN persona's email is expected to be in `BOOTSTRAP_ADMIN_EMAILS` for
 * the E2E environment; we still set `role='admin'` directly here so the persona
 * is admin regardless of the OAuth bootstrap path (which is mocked out).
 */

export const PERSONAS = {
  user: {
    email: "e2e-user@example.test",
    displayName: "E2E User",
    role: "user" as const,
  },
  admin: {
    email: "e2e-admin@example.test",
    displayName: "E2E Admin",
    role: "admin" as const,
  },
  unentitled: {
    email: "e2e-unentitled@example.test",
    displayName: "E2E Unentitled",
    role: "user" as const,
  },
} as const;

export const SEEDED_CATALOGUE = {
  publicAlias: "e2e-alias",
  // A STABLE (uuid-form) agent the fake Sculpin upstream actually serves, so the
  // seeded offering maps to a discoverable agent and admin drift stays empty.
  // Still admin-only; it must never appear in any client-visible surface.
  upstreamAgentId: FAKE_SECONDARY_AGENT_ID,
  displayName: "E2E Model",
  description: "Deterministic E2E catalogue entry.",
} as const;

export const SEEDED_PLAN = {
  key: "e2e-trial",
  name: "E2E Trial",
  description: "Deterministic self-service plan for E2E.",
  requestQuota: 100,
} as const;

async function seedUser(
  database: ReturnType<typeof createDatabase>,
  persona: { email: string; displayName: string; role: "user" | "admin" },
): Promise<string> {
  const id = randomUUID();
  const normalizedEmail = persona.email.trim().toLowerCase();
  // Insert the canonical users row (idempotent on normalized_email + role for a
  // clean, freshly-migrated E2E DB — the suite owns the DB lifecycle in CI).
  await database.pool.query(
    `INSERT INTO users (id, normalized_email, display_name, role, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [id, normalizedEmail, persona.displayName, persona.role],
  );
  // Provision the personal tenant via the REAL service inside one transaction.
  await database.prisma.$transaction(async (tx) => {
    await provisionPersonalTenant(tx, {
      userId: id,
      organizationSlug: personalOrganizationSlug(),
      requestId: `e2e-seed-${randomUUID()}`,
    });
  });
  return id;
}

export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("E2E global setup requires DATABASE_URL");
  }
  const database = createDatabase(databaseUrl);
  try {
    await database.ready();

    // Personas.
    const adminUserId = await seedUser(database, PERSONAS.admin);
    await seedUser(database, PERSONAS.user);
    await seedUser(database, PERSONAS.unentitled);

    // Catalogue + plan seeded via the REAL repositories (published + attached),
    // authored by the admin persona so audit provenance is real.
    const catalogueRepo = new PostgresCatalogueRepository(database.pool);
    const planRepo = new PostgresPlanRepository(database.pool);

    const entry = await catalogueRepo.create(SEEDED_CATALOGUE, adminUserId);
    await catalogueRepo.publish(entry.id, adminUserId);

    const plan = await planRepo.create(
      {
        key: SEEDED_PLAN.key,
        name: SEEDED_PLAN.name,
        description: SEEDED_PLAN.description,
        kind: "free_trial",
        selfServiceEligible: true,
        requestQuota: SEEDED_PLAN.requestQuota,
      },
      adminUserId,
    );
    await planRepo.attachCatalogueEntry(plan.id, entry.id);
    await planRepo.setPublished(plan.id, true, adminUserId);
  } finally {
    await database.close();
  }
}
