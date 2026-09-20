-- §6 admin-configurable, client-SAFE "how to use this offering" prose shown on
-- the Connect page. Multi-line plain text: tabs (\t), newlines (\n) and
-- carriage returns (\r) are allowed; every other control character is rejected.
-- The CHECK mirrors the domain `validateAccessInstructions` bound (defense in
-- depth): strip tab/newline/CR, then reject any remaining control character.
-- Nullable and forward-only: existing rows default to NULL (no instructions).
ALTER TABLE catalogue_entries
  ADD COLUMN access_instructions varchar(4096)
    CHECK (
      access_instructions IS NULL
      OR (
        length(access_instructions) <= 4096
        AND regexp_replace(access_instructions, '[\t\n\r]', '', 'g') !~ '[[:cntrl:]]'
      )
    );
