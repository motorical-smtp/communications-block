-- Compile-Before-Send schema additions
-- Tables: comm_campaign_artifacts, comm_audience_snapshots

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Stores compiled, immutable artifacts for a campaign version
CREATE TABLE IF NOT EXISTS comm_campaign_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  subject TEXT NOT NULL,
  html_compiled TEXT NOT NULL,
  text_compiled TEXT,
  meta JSONB,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, version)
);

-- Snapshot of intended audience at compile-time (immutable)
CREATE TABLE IF NOT EXISTS comm_audience_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  included_lists JSONB,
  deduped_by TEXT DEFAULT 'email',
  filters JSONB,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, version)
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_comm_artifacts_campaign ON comm_campaign_artifacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_comm_audience_campaign ON comm_audience_snapshots(campaign_id);

COMMIT;


