-- S13 per-request usage events (M7 metering tail; D-023). Exactly ONE row is
-- written in the SAME transaction as each GRANTED quota reservation (never on a
-- denial), so quota and usage commit atomically together. The row carries NO
-- secret, prompt, request/response body, raw PAT, OAuth token, or upstream key
-- (CLAUDE.md rule 5): `pat_id` is the PAT ROW uuid (a foreign key), NOT the token
-- secret, and `quota_cost` is the number of quota units reserved. `request_id` is
-- the safe correlation id. All foreign keys are ON DELETE RESTRICT / ON UPDATE NO
-- ACTION so a referenced org/subscription/catalogue entry/PAT cannot vanish out
-- from under a recorded usage row.
CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  catalogue_entry_id uuid NOT NULL,
  pat_id uuid NOT NULL,
  request_id varchar(128) NOT NULL,
  quota_cost integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT usage_events_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT usage_events_catalogue_entry_id_fkey FOREIGN KEY (catalogue_entry_id) REFERENCES catalogue_entries(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT usage_events_pat_id_fkey FOREIGN KEY (pat_id) REFERENCES personal_access_tokens(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX idx_usage_events_org_occurred ON usage_events (organization_id, occurred_at);
