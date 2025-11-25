-- Add from_address column to campaigns table
-- Allows campaigns to specify custom "from" email address from user's verified domains

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS from_address TEXT;

-- Add comment for clarity
COMMENT ON COLUMN campaigns.from_address IS 'Custom from email address for this campaign (e.g., noreply@domain.com). If NULL, uses default COMM_FROM_ADDRESS.';

