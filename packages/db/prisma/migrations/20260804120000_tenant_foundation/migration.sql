CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('active', 'deactivated');
CREATE TYPE organization_type AS ENUM ('personal', 'team');
CREATE TYPE organization_status AS ENUM ('active', 'suspended');
CREATE TYPE membership_role AS ENUM ('owner', 'member');
CREATE TYPE membership_status AS ENUM ('active', 'inactive');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email varchar(254) NOT NULL CHECK (normalized_email = lower(btrim(normalized_email)) AND normalized_email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  display_name varchar(120) NOT NULL CHECK (display_name ~ '\S'),
  status user_status NOT NULL DEFAULT 'active',
  locale varchar(16) NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2}|-[A-Za-z]{4})?$'),
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL))
);
CREATE INDEX idx_users_normalized_email ON users (normalized_email);
CREATE INDEX idx_users_status ON users (status);

CREATE FUNCTION is_safe_external_identity_metadata(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR (
    jsonb_typeof(value) = 'object'
    AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value) AS key) <@ ARRAY['issuer','schemaVersion','tenant']
    AND value ? 'schemaVersion'
    AND jsonb_typeof(value->'schemaVersion') = 'number'
    AND value->>'schemaVersion' = '1'
    AND NOT (value ?| ARRAY['authorization','cookie','token','secret','password','passphrase','apikey','clientsecret','databaseurl','connectionstring','credential','session'])
    AND (NOT value ? 'issuer' OR (jsonb_typeof(value->'issuer') = 'string' AND length(value->>'issuer') BETWEEN 1 AND 120))
    AND (NOT value ? 'tenant' OR (jsonb_typeof(value->'tenant') = 'string' AND length(value->>'tenant') BETWEEN 1 AND 120))
  );
$$;

CREATE TABLE external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider varchar(32) NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_subject varchar(255) NOT NULL CHECK (provider_subject !~ '[[:cntrl:]]' AND btrim(provider_subject) <> ''),
  provider_email varchar(254) CHECK (provider_email IS NULL OR lower(provider_email) ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  email_verified boolean NOT NULL DEFAULT false,
  safe_metadata jsonb CHECK (is_safe_external_identity_metadata(safe_metadata)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_subject)
);
CREATE INDEX idx_external_identities_user_id ON external_identities (user_id);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(63) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  type organization_type NOT NULL,
  personal_owner_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  status organization_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((type = 'personal') = (personal_owner_user_id IS NOT NULL))
);
ALTER TABLE organizations ADD CONSTRAINT organizations_personal_owner_user_id_key UNIQUE (personal_owner_user_id);
CREATE INDEX idx_organizations_status ON organizations (status);

CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role membership_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id)
);
CREATE INDEX idx_memberships_organization_status ON organization_memberships (organization_id, status);
CREATE INDEX idx_memberships_user_status ON organization_memberships (user_id, status);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  system_actor varchar(64),
  action varchar(120) NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:-]{1,119}$'),
  target_type varchar(64) NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  target_id uuid NOT NULL,
  before_summary jsonb CHECK (before_summary IS NULL OR jsonb_typeof(before_summary) = 'object'),
  after_summary jsonb CHECK (after_summary IS NULL OR jsonb_typeof(after_summary) = 'object'),
  request_id varchar(128) NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  occurred_at timestamptz NOT NULL,
  CHECK ((actor_user_id IS NOT NULL) <> (system_actor IS NOT NULL)),
  FOREIGN KEY (organization_id, actor_user_id) REFERENCES organization_memberships(organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX idx_audit_events_org_occurred ON audit_events (organization_id, occurred_at);

CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;
CREATE TRIGGER audit_events_reject_update BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
CREATE TRIGGER audit_events_reject_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  aggregate_type varchar(64) NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  aggregate_id uuid NOT NULL,
  event_type varchar(120) NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.:-]{1,119}$'),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  claim_owner varchar(128) CHECK (claim_owner IS NULL OR claim_owner ~ '^[A-Za-z0-9._:-]{1,128}$'),
  claimed_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 10 CHECK (max_attempts BETWEEN 1 AND 100),
  processed_at timestamptz,
  terminal_error_code varchar(80) CHECK (terminal_error_code IS NULL OR terminal_error_code ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((claim_owner IS NULL) = (claimed_until IS NULL)),
  CHECK (processed_at IS NULL OR (claim_owner IS NULL AND claimed_until IS NULL AND terminal_error_code IS NULL)),
  CHECK (terminal_error_code IS NULL OR (processed_at IS NULL AND claim_owner IS NULL AND claimed_until IS NULL)),
  CHECK (attempt_count <= max_attempts),
  CHECK (attempt_count < max_attempts OR processed_at IS NOT NULL OR terminal_error_code IS NOT NULL OR claim_owner IS NOT NULL),
  CHECK (available_at >= occurred_at),
  CHECK (claimed_until IS NULL OR claimed_until > available_at)
);
CREATE INDEX idx_outbox_events_org_aggregate ON outbox_events (organization_id, aggregate_type, aggregate_id);
CREATE INDEX idx_outbox_events_pending_claim ON outbox_events (available_at, id) WHERE processed_at IS NULL AND terminal_error_code IS NULL;
CREATE INDEX idx_outbox_events_expired_claim ON outbox_events (claimed_until, id) WHERE processed_at IS NULL AND terminal_error_code IS NULL AND claimed_until IS NOT NULL;

CREATE FUNCTION enforce_personal_organization_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type = 'personal_organization.created' OR NEW.schema_version = 1 THEN
    IF NEW.event_type <> 'personal_organization.created' OR NEW.schema_version <> 1 THEN
      RAISE EXCEPTION 'personal organization outbox event shape mismatch';
    END IF;
    IF NEW.organization_id IS NULL OR NEW.aggregate_type <> 'organization' OR NEW.aggregate_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'personal organization outbox aggregate mismatch';
    END IF;
    IF jsonb_typeof(NEW.payload) <> 'object'
       OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.payload) AS key) <> ARRAY['organizationId','userId']
       OR NEW.payload->>'organizationId' <> NEW.organization_id::text
       OR NEW.payload->>'organizationId' <> NEW.aggregate_id::text
       OR NOT (NEW.payload->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'personal organization outbox payload invalid';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM organization_memberships
      WHERE organization_id = NEW.organization_id
        AND user_id = (NEW.payload->>'userId')::uuid
        AND role = 'owner'
        AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'personal organization outbox owner missing';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outbox_events_enforce_personal_organization BEFORE INSERT OR UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION enforce_personal_organization_outbox();

