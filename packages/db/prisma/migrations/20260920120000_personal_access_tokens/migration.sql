-- M5 Personal Access Tokens (CLAUDE.md rule 2 / ADR 007). The wire token
-- `sclp_pat_<public_id>_<secret>` is shown ONCE at mint; only an HMAC-SHA-256
-- keyed digest of the secret (`secret_hash`, key `PAT_HASH_SECRET` kept OUTSIDE
-- the DB) is persisted, so a DB leak yields no usable bearer credential. The raw
-- secret is NEVER stored. `public_id` is the unauthenticated lookup handle;
-- authentication re-derives an active user/org/membership and verifies the secret
-- in constant time. Revocation/expiry removes the row from the active set.
CREATE TYPE pat_status AS ENUM ('active', 'revoked');

CREATE TABLE personal_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id varchar(64) NOT NULL,
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  name varchar(120) NOT NULL,
  secret_hash varchar(128) NOT NULL,
  status pat_status NOT NULL DEFAULT 'active',
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT personal_access_tokens_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT personal_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT personal_access_tokens_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX personal_access_tokens_public_id_key ON personal_access_tokens (public_id);
CREATE INDEX idx_personal_access_tokens_user_status ON personal_access_tokens (user_id, status);
CREATE INDEX idx_personal_access_tokens_org_status ON personal_access_tokens (organization_id, status);
