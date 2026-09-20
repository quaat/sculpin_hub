-- §10: platform-global / admin cross-org audit events.
-- Catalogue & plan CRUD have no tenant org; an admin granting or transitioning a
-- subscription for a tenant is not a member of that tenant. The composite FK
-- (organization_id, actor_user_id) -> organization_memberships would otherwise
-- force every user-attributed event to be by a MEMBER of the named org. Allow a
-- NULL organization_id: under MATCH SIMPLE the composite membership FK is skipped
-- when a referenced column is NULL, while the separate actor_user_id -> users FK
-- still validates the responsible human. The affected org (when any) is named in
-- after_summary instead. The XOR actor CHECK and the append-only triggers are
-- unchanged. A NULL org is permitted ONLY for a user-attributed event, so every
-- global event still names a responsible admin (never an orgless system actor).
ALTER TABLE audit_events ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_global_requires_user_actor
  CHECK (organization_id IS NOT NULL OR actor_user_id IS NOT NULL);
-- Recent-first listing across all orgs (admin audit view).
CREATE INDEX idx_audit_events_occurred_at ON audit_events (occurred_at DESC);
