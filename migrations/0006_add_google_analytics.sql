-- Add Google Analytics configuration to campaigns
-- Adds support for SendGrid-style UTM parameter management

ALTER TABLE campaigns ADD COLUMN google_analytics JSONB DEFAULT '{"enabled": false}';

-- Add example/default GA settings structure:
-- {
--   "enabled": true,
--   "utm_source": "motorical_email",
--   "utm_medium": "email", 
--   "utm_campaign": "vehicle_rental_2024",
--   "utm_content": "email_link",
--   "utm_term": "optional"
-- }

-- Update existing campaigns to have default GA settings
UPDATE campaigns SET google_analytics = '{"enabled": false}' WHERE google_analytics IS NULL;

-- Make google_analytics NOT NULL with default
ALTER TABLE campaigns ALTER COLUMN google_analytics SET NOT NULL;
ALTER TABLE campaigns ALTER COLUMN google_analytics SET DEFAULT '{"enabled": false}';

-- Add index for GA enabled campaigns (for potential analytics queries)
CREATE INDEX IF NOT EXISTS idx_campaigns_ga_enabled ON campaigns 
USING GIN ((google_analytics->'enabled')) WHERE (google_analytics->>'enabled')::boolean = true;

COMMENT ON COLUMN campaigns.google_analytics IS 'Google Analytics UTM parameter configuration for SendGrid-style link tracking';
