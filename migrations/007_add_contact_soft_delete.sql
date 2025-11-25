-- Migration: Add soft delete functionality to contacts (recipients)
-- Date: 2025-09-13
-- Purpose: Enable recycle bin for recipients with historical data preservation

-- Add deleted_at column to contacts table
ALTER TABLE contacts 
ADD COLUMN deleted_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NULL;

-- Add index for efficient querying of non-deleted contacts
CREATE INDEX idx_contacts_deleted_at ON contacts(deleted_at) WHERE deleted_at IS NOT NULL;

-- Add index for efficient querying of active contacts by tenant
CREATE INDEX idx_contacts_active_tenant ON contacts(tenant_id, created_at DESC) WHERE deleted_at IS NULL;

-- Comment for documentation
COMMENT ON COLUMN contacts.deleted_at IS 'Timestamp when contact was soft deleted. NULL means active contact.';

-- Grant permissions to motorical user
GRANT ALL PRIVILEGES ON contacts TO motorical;
