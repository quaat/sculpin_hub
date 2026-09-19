-- M3 model catalogue. Maps a client-visible public alias (the OpenAI `model`
-- id) to an internal Sculpin upstream agent id. Only `published` rows resolve
-- (fail closed); the upstream agent id is never projected to clients. Column
-- CHECKs mirror the domain validation (defense in depth); created_by/updated_by
-- record the acting admin for traceability.
CREATE TYPE catalogue_entry_status AS ENUM ('draft', 'published', 'disabled');

CREATE TABLE catalogue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_alias varchar(64) NOT NULL CHECK (public_alias ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  upstream_agent_id varchar(255) NOT NULL CHECK (upstream_agent_id !~ '[[:cntrl:]]' AND btrim(upstream_agent_id) = upstream_agent_id AND length(upstream_agent_id) BETWEEN 1 AND 255),
  display_name varchar(120) NOT NULL CHECK (display_name ~ '\S'),
  description varchar(2048) CHECK (description IS NULL OR (description !~ '[[:cntrl:]]' AND length(description) <= 2048)),
  status catalogue_entry_status NOT NULL DEFAULT 'draft',
  created_by_user_id uuid,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT catalogue_entries_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT catalogue_entries_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX catalogue_entries_public_alias_key ON catalogue_entries (public_alias);
CREATE INDEX idx_catalogue_entries_status ON catalogue_entries (status);
