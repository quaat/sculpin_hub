CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('active', 'deactivated');
CREATE TYPE organization_type AS ENUM ('personal', 'team');
CREATE TYPE organization_status AS ENUM ('active', 'suspended');
CREATE TYPE membership_role AS ENUM ('owner', 'member');
CREATE TYPE membership_status AS ENUM ('active', 'inactive');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), normalized_email text NOT NULL,
  display_name text NOT NULL, status user_status NOT NULL DEFAULT 'active', locale text NOT NULL,
  deactivated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL))
);
CREATE TABLE external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider text NOT NULL, provider_subject text NOT NULL, provider_email text,
  email_verified boolean NOT NULL, claims jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject), CHECK (jsonb_typeof(claims) = 'object')
);
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE,
  type organization_type NOT NULL, status organization_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, role membership_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, user_id)
);
CREATE INDEX organization_memberships_tenant_status_idx ON organization_memberships (organization_id, status);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT, system_actor text,
  action text NOT NULL, target_type text NOT NULL, target_id uuid NOT NULL,
  before_summary jsonb, after_summary jsonb, request_id text NOT NULL, occurred_at timestamptz NOT NULL,
  CHECK ((actor_user_id IS NULL) <> (system_actor IS NULL))
);
CREATE INDEX audit_events_tenant_occurred_idx ON audit_events (organization_id, occurred_at DESC);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0), payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL, available_at timestamptz NOT NULL,
  claim_owner text, claimed_until timestamptz, attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0), processed_at timestamptz,
  terminal_error_code text, version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK ((claim_owner IS NULL) = (claimed_until IS NULL)),
  CHECK (attempt_count >= 0 AND attempt_count <= max_attempts)
);
CREATE INDEX outbox_events_tenant_pending_idx ON outbox_events (organization_id, available_at) WHERE processed_at IS NULL;
CREATE INDEX outbox_events_claim_idx ON outbox_events (available_at, claimed_until) WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit events are append-only'; END $$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
