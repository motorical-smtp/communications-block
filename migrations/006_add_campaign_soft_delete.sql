-- Migration: Add soft delete functionality to campaigns
-- Date: 2025-09-13
-- Purpose: Preserve Mega List historical data by implementing soft delete

-- Add deleted_at column to campaigns table
ALTER TABLE campaigns 
ADD COLUMN deleted_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NULL;

-- Add index for efficient querying of non-deleted campaigns
CREATE INDEX idx_campaigns_deleted_at ON campaigns(deleted_at) WHERE deleted_at IS NOT NULL;

-- Add index for efficient querying of active campaigns by tenant
CREATE INDEX idx_campaigns_active_tenant ON campaigns(tenant_id, created_at DESC) WHERE deleted_at IS NULL;

-- Comment for documentation
COMMENT ON COLUMN campaigns.deleted_at IS 'Timestamp when campaign was soft deleted. NULL means active campaign.';

-- Grant permissions to motorical user
GRANT ALL PRIVILEGES ON campaigns TO motorical;
