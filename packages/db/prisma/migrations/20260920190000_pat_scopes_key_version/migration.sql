-- S4 PAT catalogue scopes + verifier-key versioning (CLAUDE.md rule 2).
--
-- 1. Add `hash_key_version` so PAT_HASH_SECRET can be ROTATED without
--    invalidating live tokens: each row records the keyring version its digest
--    was computed under. Existing rows get version 1 via the constant DEFAULT
--    (instant in PostgreSQL; no backfill statement needed). NOT NULL is safe
--    because the default applies to every existing and future row.
--
-- 2. Add `personal_access_token_scopes`: the IMMUTABLE catalogue-entry scopes a
--    PAT is narrowed to. Rows are inserted ONLY at mint and never updated. ZERO
--    rows means "unscoped" (inherit the principal's full entitlement). The FK to
--    catalogue_entries is ON DELETE RESTRICT (a scoped entry cannot vanish out
--    from under a live PAT); the FK to the PAT is ON DELETE CASCADE (scopes die
--    with their token).

-- 1. Key-version column.
ALTER TABLE personal_access_tokens
  ADD COLUMN hash_key_version smallint NOT NULL DEFAULT 1;

-- 2. Immutable PAT -> catalogue-entry scope table.
CREATE TABLE personal_access_token_scopes (
  pat_id uuid NOT NULL,
  catalogue_entry_id uuid NOT NULL,
  PRIMARY KEY (pat_id, catalogue_entry_id),
  CONSTRAINT personal_access_token_scopes_pat_id_fkey FOREIGN KEY (pat_id) REFERENCES personal_access_tokens(id) ON DELETE CASCADE,
  CONSTRAINT personal_access_token_scopes_catalogue_entry_id_fkey FOREIGN KEY (catalogue_entry_id) REFERENCES catalogue_entries(id) ON DELETE RESTRICT
);

CREATE INDEX idx_personal_access_token_scopes_entry ON personal_access_token_scopes (catalogue_entry_id);
