-- Migration: Update recipient_status view to exclude soft-deleted contacts
-- Date: 2025-09-13
-- Purpose: Ensure recipient_status view only shows active (non-deleted) contacts

-- Drop the existing view
DROP VIEW IF EXISTS recipient_status;

-- Recreate the view with soft delete filter
CREATE VIEW recipient_status AS
SELECT 
  c.id,
  c.tenant_id,
  c.email,
  c.name,
  c.status as contact_status,
  c.quality_index,
  c.last_engagement_at,
  ee_clicked.occurred_at as last_click_at,
  c.created_at,
  
  -- Compute engagement status based on email events and suppressions
  CASE 
    WHEN s.reason IS NOT NULL THEN 
      CASE s.reason
        WHEN 'unsubscribe' THEN 'unsubscribed'
        WHEN 'complaint' THEN 'complained'
        WHEN 'bounce' THEN 'bounced'
        ELSE 'suppressed'
      END
    WHEN ee_clicked.occurred_at IS NOT NULL THEN 'engaged'
    WHEN ee_delivered.occurred_at IS NOT NULL THEN 'sent'
    WHEN ee_sent.occurred_at IS NOT NULL THEN 'sent'
    ELSE 'new'
  END as computed_status,
  
  -- Suppression details
  s.reason as suppression_reason,
  s.created_at as suppressed_at,
  
  -- Engagement level
  CASE 
    WHEN ee_clicked.occurred_at IS NOT NULL THEN 'high'
    WHEN ee_delivered.occurred_at IS NOT NULL THEN 'medium'
    WHEN ee_sent.occurred_at IS NOT NULL THEN 'low'
    ELSE 'none'
  END as engagement_level,
  
  -- Domain extraction
  SPLIT_PART(c.email, '@', 2) as email_domain,
  
  -- Count of lists this contact belongs to
  COALESCE(list_counts.list_count, 0) as list_count,
  
  -- Last campaign activity
  ee_recent.campaign_id as last_campaign_id,
  ee_recent.occurred_at as last_campaign_activity

FROM contacts c
  -- Left join suppressions
  LEFT JOIN suppressions s ON s.contact_id = c.id AND s.tenant_id = c.tenant_id
  
  -- Left join latest clicked event
  LEFT JOIN LATERAL (
    SELECT ee.occurred_at 
    FROM email_events ee 
    WHERE ee.contact_id = c.id AND ee.type = 'clicked' 
    ORDER BY ee.occurred_at DESC 
    LIMIT 1
  ) ee_clicked ON true
  
  -- Left join latest delivered event
  LEFT JOIN LATERAL (
    SELECT ee.occurred_at 
    FROM email_events ee 
    WHERE ee.contact_id = c.id AND ee.type = 'delivered' 
    ORDER BY ee.occurred_at DESC 
    LIMIT 1
  ) ee_delivered ON true
  
  -- Left join latest sent event
  LEFT JOIN LATERAL (
    SELECT ee.occurred_at 
    FROM email_events ee 
    WHERE ee.contact_id = c.id AND ee.type = 'sent' 
    ORDER BY ee.occurred_at DESC 
    LIMIT 1
  ) ee_sent ON true
  
  -- Left join most recent email event (any type)
  LEFT JOIN LATERAL (
    SELECT ee.campaign_id, ee.occurred_at 
    FROM email_events ee 
    WHERE ee.contact_id = c.id 
    ORDER BY ee.occurred_at DESC 
    LIMIT 1
  ) ee_recent ON true
  
  -- Left join list count
  LEFT JOIN LATERAL (
    SELECT COUNT(*) as list_count 
    FROM list_contacts lc 
    WHERE lc.contact_id = c.id
  ) list_counts ON true

-- Only include active (non-deleted) contacts
WHERE c.deleted_at IS NULL;

-- Grant permissions
GRANT SELECT ON recipient_status TO motorical;
