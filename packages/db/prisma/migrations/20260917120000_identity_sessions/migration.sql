-- M2 identity slice: platform role + Better Auth session/verification tables.
-- Additive migration; the existing tenant-foundation triggers/constraints are
-- left intact. Better Auth's `user` maps to `users` and `account` maps to
-- `external_identities` via field-mapping in the auth config; no email/
-- emailVerified/image columns are added to `users`, and provider access/
-- refresh/id tokens are deliberately NOT persisted (minimal token retention).

-- Platform role (USER/ADMIN), distinct from the org-scoped membership_role.
CREATE TYPE platform_role AS ENUM ('user', 'admin');

ALTER TABLE users
  ADD COLUMN role platform_role NOT NULL DEFAULT 'user';

-- Better Auth server-side (database) session. The cookie carries only the
-- opaque token; revocation deletes/expires the row.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token varchar(255) NOT NULL,
  expires_at timestamptz NOT NULL,
  ip_address varchar(64),
  user_agent varchar(512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_key UNIQUE (token)
);
CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

-- Better Auth verification table (email verification / one-time values).
CREATE TABLE verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier varchar(255) NOT NULL,
  value varchar(512) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_verifications_identifier ON verifications (identifier);
