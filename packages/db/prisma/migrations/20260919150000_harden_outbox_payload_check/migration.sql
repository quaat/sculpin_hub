-- Harden the personal-organization outbox trigger so a structurally degenerate
-- payload (e.g. `{}`) is classified as "payload invalid" BEFORE the owner check.
--
-- Bug: the original check compared `array_agg(key) <> ARRAY['organizationId','userId']`.
-- For an empty object, `array_agg` over zero keys returns NULL, so the whole
-- boolean OR evaluated to NULL (not TRUE) and the "payload invalid" branch was
-- skipped. The row was still rejected -- but downstream as "owner missing"
-- (because `payload->>'userId'` was NULL), which misclassifies a malformed
-- payload as a membership problem. Coalescing the key array to an empty text[]
-- makes the comparison TRUE for a degenerate payload so it is correctly rejected
-- as invalid, and guards `userId` explicitly. Security outcome is unchanged
-- (the insert is still rejected); the classification is now correct.
CREATE OR REPLACE FUNCTION enforce_personal_organization_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type = 'personal_organization.created' THEN
    IF NEW.schema_version <> 1 THEN
      RAISE EXCEPTION 'personal organization outbox event shape mismatch';
    END IF;
    IF NEW.organization_id IS NULL OR NEW.aggregate_type <> 'organization' OR NEW.aggregate_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'personal organization outbox aggregate mismatch';
    END IF;
    IF jsonb_typeof(NEW.payload) <> 'object'
       OR COALESCE((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.payload) AS key), ARRAY[]::text[]) <> ARRAY['organizationId','userId']
       OR NEW.payload->>'organizationId' IS DISTINCT FROM NEW.organization_id::text
       OR NEW.payload->>'organizationId' IS DISTINCT FROM NEW.aggregate_id::text
       OR NEW.payload->>'userId' IS NULL
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
