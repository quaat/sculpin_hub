-- Align the identity schema with Better Auth 1.7.5's expected user/account
-- columns so OAuth sign-up inserts succeed and the adapter's runtime schema
-- check passes. NOTE: this intentionally adds provider access/refresh/id token
-- columns to external_identities, which broadens token retention beyond the
-- original minimal-retention posture (CLAUDE.md rule 5) per an explicit product
-- decision. Additive only.

-- Better Auth writes emailVerified + image on the user, and never writes locale
-- (so it needs a default).
ALTER TABLE users
  ALTER COLUMN locale SET DEFAULT 'en',
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN image varchar(2048);

-- Better Auth account (OAuth) token + credential columns on external_identities.
ALTER TABLE external_identities
  ADD COLUMN access_token text,
  ADD COLUMN refresh_token text,
  ADD COLUMN id_token text,
  ADD COLUMN access_token_expires_at timestamptz,
  ADD COLUMN refresh_token_expires_at timestamptz,
  ADD COLUMN scope varchar(512),
  ADD COLUMN password varchar(255);
