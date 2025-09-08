-- communications_db initial schema (UUID everywhere)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- tenants
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  motorical_account_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

-- contacts
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  name TEXT,
  phone TEXT,
  identity_type VARCHAR(20) CHECK (identity_type IN ('company','individual')),
  identity_name TEXT,
  quality_index INTEGER NOT NULL DEFAULT 50,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_engagement_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

-- lists
CREATE TABLE IF NOT EXISTS lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

-- list_contacts
CREATE TABLE IF NOT EXISTS list_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(list_id, contact_id)
);

-- suppressions
CREATE TABLE IF NOT EXISTS suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  reason VARCHAR(50) NOT NULL,
  source VARCHAR(50),
  landing_variant VARCHAR(20),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

-- templates
CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('html','text')),
  body_html TEXT,
  body_text TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

-- campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  motor_block_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('draft','scheduled','sending','completed','cancelled')) DEFAULT 'draft',
  scheduled_at TIMESTAMP WITHOUT TIME ZONE,
  timezone TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

-- campaign_lists
CREATE TABLE IF NOT EXISTS campaign_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  UNIQUE(campaign_id, list_id)
);

-- campaign_send_settings
CREATE TABLE IF NOT EXISTS campaign_send_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  chunk_size INTEGER NOT NULL DEFAULT 100,
  delay_seconds_between_chunks INTEGER NOT NULL DEFAULT 30
);

-- email_events
CREATE TABLE IF NOT EXISTS email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id UUID,
  message_id TEXT,
  motor_block_id UUID,
  type VARCHAR(20) NOT NULL CHECK (type IN ('queued','sending','sent','delivered','bounced','complained','failed','blocked')),
  payload JSONB,
  occurred_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

-- tenant_settings
CREATE TABLE IF NOT EXISTS tenant_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unsubscribe_mode VARCHAR(20) NOT NULL CHECK (unsubscribe_mode IN ('customer','motorical')) DEFAULT 'customer',
  custom_unsubscribe_url TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id)
);

-- indexes
CREATE INDEX IF NOT EXISTS idx_email_events_campaign ON email_events(campaign_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_email_events_type ON email_events(type);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_email ON contacts(tenant_id, email);


