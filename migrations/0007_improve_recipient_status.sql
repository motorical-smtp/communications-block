-- Improve recipient status computation to use real-time analytics classification
-- This integrates with the campaign analytics "accepted" vs "delivered" metrics

-- Drop the existing view to recreate it with improved logic
DROP VIEW IF EXISTS recipient_status;

-- Create enhanced recipient status view that uses analytics classification
CREATE OR REPLACE VIEW recipient_status AS 
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
  
  -- Enhanced status computation using analytics classification
  CASE 
    WHEN s.email IS NOT NULL THEN 'unsubscribed'
    WHEN ee_complained.contact_id IS NOT NULL THEN 'complained'  
    WHEN ee_bounced.contact_id IS NOT NULL THEN 'bounced'
    WHEN ee_clicked.contact_id IS NOT NULL THEN 'engaged'
    -- Use campaign analytics classification for sent/delivered
    WHEN latest_analytics.classification = 'delivered' THEN 'delivered'
    WHEN latest_analytics.classification = 'accepted' THEN 'sent'
    WHEN ee_queued.contact_id IS NOT NULL THEN 'queued'
    ELSE 'new'
  END as computed_status,
  
  -- Suppression information
  CASE 
    WHEN s.email IS NOT NULL THEN 'suppressed'
    WHEN ee_complained.contact_id IS NOT NULL THEN 'suppressed'
    WHEN ee_bounced.contact_id IS NOT NULL THEN 'suppressed'
    ELSE NULL
  END as suppression_reason,
  s.created_at as suppressed_at,
  
  -- Enhanced engagement scoring using real analytics data
  CASE 
    WHEN ee_clicked.contact_id IS NOT NULL AND ee_clicked.occurred_at > NOW() - INTERVAL '30 days' THEN 'high'
    WHEN ee_clicked.contact_id IS NOT NULL AND ee_clicked.occurred_at > NOW() - INTERVAL '90 days' THEN 'medium'
    WHEN latest_analytics.classification = 'delivered' AND latest_analytics.occurred_at > NOW() - INTERVAL '30 days' THEN 'low'
    WHEN latest_analytics.classification = 'accepted' AND latest_analytics.occurred_at > NOW() - INTERVAL '60 days' THEN 'low'
    ELSE 'none'
  END as engagement_level,
  
  -- Email domain for filtering
  split_part(c.email, '@', 2) as email_domain,
  
  -- List membership count
  (SELECT COUNT(DISTINCT lc.list_id) FROM list_contacts lc WHERE lc.contact_id = c.id) as list_count,
  
  -- Latest campaign activity from analytics
  latest_analytics.campaign_id as last_campaign_id,
  latest_analytics.occurred_at as last_campaign_activity,
  
  -- Analytics classification for transparency
  latest_analytics.classification as last_event_type

FROM contacts c

-- Suppressions
LEFT JOIN suppressions s ON s.tenant_id = c.tenant_id AND s.email = c.email

-- Complained events
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'complained' 
  ORDER BY contact_id, occurred_at DESC
) ee_complained ON ee_complained.contact_id = c.id

-- Bounced events (may not exist yet, but prepared for future)
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'bounced' 
  ORDER BY contact_id, occurred_at DESC
) ee_bounced ON ee_bounced.contact_id = c.id

-- Clicked events (real engagement)
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'clicked' 
  ORDER BY contact_id, occurred_at DESC
) ee_clicked ON ee_clicked.contact_id = c.id

-- Queued events (campaign started)
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) contact_id, occurred_at 
  FROM email_events 
  WHERE type = 'queued' 
  ORDER BY contact_id, occurred_at DESC
) ee_queued ON ee_queued.contact_id = c.id

-- Enhanced: Latest campaign analytics with proper classification
LEFT JOIN (
  SELECT DISTINCT ON (contact_id) 
    contact_id, 
    campaign_id,
    occurred_at,
    -- Use the same classification logic as campaign analytics
    CASE 
      WHEN type = 'clicked' THEN 'clicked'
      WHEN type = 'complained' THEN 'complained'
      -- Map queued to accepted (emails successfully sent to provider)
      WHEN type = 'queued' THEN 'accepted'
      -- Future: map delivery confirmations to delivered
      WHEN type = 'delivered' THEN 'delivered'
      WHEN type = 'bounced' THEN 'bounced'
      WHEN type = 'failed' THEN 'failed'
      ELSE 'accepted'
    END as classification
  FROM email_events 
  WHERE contact_id IS NOT NULL
  ORDER BY contact_id, occurred_at DESC
) latest_analytics ON latest_analytics.contact_id = c.id

WHERE c.status != 'deleted';  -- Exclude soft-deleted recipients from normal view

-- Grant permissions to motorical user
GRANT SELECT ON recipient_status TO motorical;

-- Add helpful comment
COMMENT ON VIEW recipient_status IS 'Enhanced recipient status view that integrates with campaign analytics classification for accurate sent/delivered metrics';
