-- Prune OAuth access/refresh/id token retention from external_identities.
-- The Hub authenticates with Google/GitHub but never calls a provider API on
-- the user's behalf, so it does not need these credentials. Dropping them
-- guarantees a DB leak cannot yield usable provider tokens (CLAUDE.md rule 5 /
-- ADR 006). Reverses the token columns added in 20260919120000. The auth layer
-- additionally strips these fields before write and disables update-on-sign-in.
ALTER TABLE external_identities
  DROP COLUMN IF EXISTS access_token,
  DROP COLUMN IF EXISTS refresh_token,
  DROP COLUMN IF EXISTS id_token,
  DROP COLUMN IF EXISTS access_token_expires_at,
  DROP COLUMN IF EXISTS refresh_token_expires_at,
  DROP COLUMN IF EXISTS scope,
  DROP COLUMN IF EXISTS password;
