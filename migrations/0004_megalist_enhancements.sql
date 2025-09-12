-- Mega List Database Enhancements
-- Support for Excel-like recipient filtering and list management

-- 1. Enhance lists table with types and filtering
ALTER TABLE lists ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'user' 
  CHECK (type IN ('user','smart','snapshot','system'));
ALTER TABLE lists ADD COLUMN IF NOT EXISTS filter_definition JSONB;
ALTER TABLE lists ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITHOUT TIME ZONE;

-- 2. Create recipient status view (computed from existing data)
CREATE OR REPLACE VIEW recipient_status AS 
SELECT 
  c.id, 
  c.tenant_id, 
  c.email, 
  c.name,
  c.status as contact_status,
  c.quality_index, 
  c.last_engagement_at,
  c.created_at,
  -- Compute status based on engagement and events
  CASE 
    WHEN s.email IS NOT NULL THEN 'unsubscribed'
    WHEN ee_complained.contact_id IS NOT NULL THEN 'complained'  
    WHEN ee_bounced.contact_id IS NOT NULL THEN 'bounced'
    WHEN ee_clicked.contact_id IS NOT NULL THEN 'engaged'
    WHEN ee_delivered.contact_id IS NOT NULL THEN 'delivered'
    WHEN ee_sent.contact_id IS NOT NULL THEN 'sent'
    ELSE 'new'
  END as computed_status,
  -- Include suppression info
  s.reason as suppression_reason,
  s.created_at as suppressed_at,
  -- Latest campaign activity
  latest_campaign.campaign_id as last_campaign_id,
  latest_campaign.occurred_at as last_campaign_activity,
  -- Click activity
  latest_click.occurred_at as last_click_at,
  -- Engagement metrics
  CASE 
    WHEN ee_clicked.contact_id IS NOT NULL AND ee_clicked.occurred_at > NOW() - INTERVAL '30 days' THEN 'high'
    WHEN ee_delivered.contact_id IS NOT NULL AND ee_delivered.occurred_at > NOW() - INTERVAL '60 days' THEN 'medium'
    WHEN ee_sent.contact_id IS NOT NULL THEN 'low'
    ELSE 'none'
  END as engagement_level
FROM contacts c
LEFT JOIN suppressions s ON s.tenant_id = c.tenant_id AND s.email = c.email
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'complained' 
  ORDER BY contact_id, occurred_at DESC
) ee_complained ON ee_complained.contact_id = c.id
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'bounced' 
  ORDER BY contact_id, occurred_at DESC
) ee_bounced ON ee_bounced.contact_id = c.id
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'clicked' 
  ORDER BY contact_id, occurred_at DESC
) ee_clicked ON ee_clicked.contact_id = c.id
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'delivered' 
  ORDER BY contact_id, occurred_at DESC
) ee_delivered ON ee_delivered.contact_id = c.id
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'sent' 
  ORDER BY contact_id, occurred_at DESC
) ee_sent ON ee_sent.contact_id = c.id
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, campaign_id, occurred_at 
  FROM email_events 
  ORDER BY contact_id, occurred_at DESC
) latest_campaign ON latest_campaign.contact_id = c.id
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'clicked' 
  ORDER BY contact_id, occurred_at DESC
) latest_click ON latest_click.contact_id = c.id;

-- 3. Create indexes for efficient filtering
CREATE INDEX IF NOT EXISTS idx_email_events_contact_type ON email_events(contact_id, type);
CREATE INDEX IF NOT EXISTS idx_email_events_contact_occurred ON email_events(contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_suppressions_tenant_email ON suppressions(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_status ON contacts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_created ON contacts(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_engagement ON contacts(tenant_id, last_engagement_at DESC);
CREATE INDEX IF NOT EXISTS idx_lists_tenant_type ON lists(tenant_id, type, deleted_at);
CREATE INDEX IF NOT EXISTS idx_list_contacts_list_status ON list_contacts(list_id, status);

-- 4. Create system lists for special purposes
INSERT INTO lists (tenant_id, name, type, filter_definition) 
SELECT DISTINCT tenant_id, 'All Recipients', 'system', '{"type": "all"}' 
FROM tenants 
WHERE NOT EXISTS (
  SELECT 1 FROM lists 
  WHERE lists.tenant_id = tenants.id AND lists.type = 'system' AND lists.name = 'All Recipients'
);

INSERT INTO lists (tenant_id, name, type, filter_definition) 
SELECT DISTINCT tenant_id, 'Engaged Recipients', 'system', '{"computed_status": ["engaged"], "engagement_level": ["high", "medium"]}' 
FROM tenants 
WHERE NOT EXISTS (
  SELECT 1 FROM lists 
  WHERE lists.tenant_id = tenants.id AND lists.type = 'system' AND lists.name = 'Engaged Recipients'
);

INSERT INTO lists (tenant_id, name, type, filter_definition) 
SELECT DISTINCT tenant_id, 'Unengaged Recipients', 'system', '{"computed_status": ["sent", "delivered"], "engagement_level": ["low", "none"]}' 
FROM tenants 
WHERE NOT EXISTS (
  SELECT 1 FROM lists 
  WHERE lists.tenant_id = tenants.id AND lists.type = 'system' AND lists.name = 'Unengaged Recipients'
);

-- 5. Grant permissions to motorical user
GRANT SELECT ON recipient_status TO motorical;
GRANT ALL PRIVILEGES ON lists TO motorical;
GRANT ALL PRIVILEGES ON list_contacts TO motorical;
GRANT ALL PRIVILEGES ON contacts TO motorical;
GRANT ALL PRIVILEGES ON email_events TO motorical;
GRANT ALL PRIVILEGES ON suppressions TO motorical;
