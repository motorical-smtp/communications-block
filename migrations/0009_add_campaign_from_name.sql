-- Add from_name column to campaigns table for sender display name
-- This allows a separate display name from the campaign name

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS from_name TEXT;

COMMENT ON COLUMN campaigns.from_name IS 'Sender display name for this campaign (e.g., "John Doe"). If NULL, falls back to campaign name. Used in From header: "Display Name" <email@domain.com>';

