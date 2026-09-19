-- M4 subscriptions & entitlements (NO payment provider; D-004/D-015). A tenant's
-- entitlement is the union of its active, in-window subscriptions. Every personal
-- tenant is provisioned with a `trial` so a valid credential alone cannot call
-- `/v1/*`. Quota reservation is an atomic conditional UPDATE; the
-- `quota_used <= quota_limit` CHECK is defense in depth against over-draw.
CREATE TYPE subscription_plan AS ENUM ('trial', 'commercial');
CREATE TYPE subscription_status AS ENUM ('active', 'canceled', 'expired');

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  plan subscription_plan NOT NULL,
  status subscription_status NOT NULL DEFAULT 'active',
  quota_limit integer NOT NULL CHECK (quota_limit >= 0),
  quota_used integer NOT NULL DEFAULT 0 CHECK (quota_used >= 0),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT subscriptions_quota_used_within_limit CHECK (quota_used <= quota_limit),
  CONSTRAINT subscriptions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
);

CREATE INDEX idx_subscriptions_org_status ON subscriptions (organization_id, status);
