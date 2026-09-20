-- S3 Plan domain & explicit subscription claim (D-019, supersedes the
-- trial-on-provisioning slice of D-015). Replaces the two-value subscription
-- `plan` enum with an admin-configurable `plans` catalogue, an AUTHORITATIVE
-- plan→catalogue-entry mapping, per-subscription SNAPSHOTS of the plan kind and
-- its catalogue-entry set (frozen at grant time), a one-time-per-organization
-- claim ledger, and a `suspended` subscription state. Entitlement→agent mapping
-- now derives from the snapshotted set; a newly provisioned tenant has NO
-- subscription until it explicitly claims a plan.

-- 1. Plan kind enum.
CREATE TYPE plan_kind AS ENUM ('free_trial', 'commercial_monthly', 'commercial_annual');

-- 2. Plans (admin-configurable products). Column CHECKs mirror domain validation.
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(63) NOT NULL CHECK (key ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  name varchar(120) NOT NULL CHECK (name ~ '\S'),
  description varchar(2048) CHECK (description IS NULL OR (description !~ '[[:cntrl:]]' AND length(description) <= 2048)),
  kind plan_kind NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  published boolean NOT NULL DEFAULT false,
  self_service_eligible boolean NOT NULL DEFAULT false,
  admin_grantable boolean NOT NULL DEFAULT true,
  duration_days integer CHECK (duration_days IS NULL OR duration_days > 0),
  request_quota integer NOT NULL CHECK (request_quota >= 0),
  one_time_per_organization boolean NOT NULL DEFAULT false,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE UNIQUE INDEX plans_key_key ON plans (key);
CREATE INDEX idx_plans_enabled_published ON plans (enabled, published);

-- 3. Authoritative plan → catalogue-entry mapping (admin-configured set).
CREATE TABLE plan_catalogue_entries (
  plan_id uuid NOT NULL,
  catalogue_entry_id uuid NOT NULL,
  PRIMARY KEY (plan_id, catalogue_entry_id),
  CONSTRAINT plan_catalogue_entries_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  CONSTRAINT plan_catalogue_entries_catalogue_entry_id_fkey FOREIGN KEY (catalogue_entry_id) REFERENCES catalogue_entries(id) ON DELETE RESTRICT
);

CREATE INDEX idx_plan_catalogue_entries_entry ON plan_catalogue_entries (catalogue_entry_id);

-- 4. One-time-per-organization claim ledger.
CREATE TABLE plan_claims (
  organization_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, plan_id),
  CONSTRAINT plan_claims_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT plan_claims_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT
);

CREATE INDEX idx_plan_claims_plan ON plan_claims (plan_id);

-- 5. Seed the default free-trial plan with a FIXED uuid so backfill can target
-- it. Catalogue offerings are attached by admins later (zero at seed is fine).
INSERT INTO plans (
  id, key, name, description, kind, enabled, published,
  self_service_eligible, admin_grantable, duration_days, request_quota,
  one_time_per_organization
) VALUES (
  '00000000-0000-4000-8000-0000000f7a11', 'free-trial', 'Free Trial',
  'Default self-service free trial granting a fixed request budget.',
  'free_trial', true, true, true, true, NULL, 200, true
);

-- 6. Swap the subscription_status enum to add 'suspended'. Postgres cannot ADD
-- VALUE inside a transaction and immediately use it, so rename + recreate + cast.
ALTER TYPE subscription_status RENAME TO subscription_status_old;
CREATE TYPE subscription_status AS ENUM ('active', 'suspended', 'canceled', 'expired');
ALTER TABLE subscriptions ALTER COLUMN status DROP DEFAULT;
ALTER TABLE subscriptions
  ALTER COLUMN status TYPE subscription_status USING status::text::subscription_status;
ALTER TABLE subscriptions ALTER COLUMN status SET DEFAULT 'active';
DROP TYPE subscription_status_old;

-- 7. Rework subscriptions: add plan_id (nullable for backfill), plan_kind, drop
-- the old plan enum column. Add the per-subscription catalogue SNAPSHOT table.
ALTER TABLE subscriptions ADD COLUMN plan_id uuid;
ALTER TABLE subscriptions ADD COLUMN plan_kind plan_kind;

-- Backfill dev-only rows (there is NO production data): point every existing
-- subscription at the seeded free-trial plan and stamp its kind.
UPDATE subscriptions
  SET plan_id = '00000000-0000-4000-8000-0000000f7a11', plan_kind = 'free_trial'
  WHERE plan_id IS NULL;

ALTER TABLE subscriptions ALTER COLUMN plan_id SET NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN plan_kind SET NOT NULL;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT;

ALTER TABLE subscriptions DROP COLUMN plan;
DROP TYPE subscription_plan;

CREATE TABLE subscription_catalogue_entries (
  subscription_id uuid NOT NULL,
  catalogue_entry_id uuid NOT NULL,
  PRIMARY KEY (subscription_id, catalogue_entry_id),
  CONSTRAINT subscription_catalogue_entries_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
  CONSTRAINT subscription_catalogue_entries_catalogue_entry_id_fkey FOREIGN KEY (catalogue_entry_id) REFERENCES catalogue_entries(id) ON DELETE RESTRICT
);

CREATE INDEX idx_subscription_catalogue_entries_entry ON subscription_catalogue_entries (catalogue_entry_id);
