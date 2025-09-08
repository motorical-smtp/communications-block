-- Customer-Scoped Suppressions Migration
-- This migration changes suppressions from tenant-scoped to motorical_account_id-scoped
-- for better compliance and cross-tenant email handling

-- Migration: 0002_customer_scoped_suppressions.sql
-- Date: 2024-12-15
-- Purpose: Migrate suppressions to be scoped by motorical_account_id instead of tenant_id

BEGIN;

-- Step 1: Add motorical_account_id column to suppressions table
ALTER TABLE suppressions 
ADD COLUMN motorical_account_id UUID;

-- Step 2: Create index for performance during backfill
CREATE INDEX idx_suppressions_tenant_id_temp ON suppressions(tenant_id);

-- Step 3: Backfill motorical_account_id from existing tenant relationships
UPDATE suppressions 
SET motorical_account_id = (
    SELECT t.motorical_account_id 
    FROM tenants t 
    WHERE t.id = suppressions.tenant_id
);

-- Step 4: Verify all suppressions have motorical_account_id
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM suppressions WHERE motorical_account_id IS NULL) THEN
        RAISE EXCEPTION 'Migration failed: Some suppressions lack motorical_account_id';
    END IF;
END $$;

-- Step 5: Make motorical_account_id NOT NULL
ALTER TABLE suppressions 
ALTER COLUMN motorical_account_id SET NOT NULL;

-- Step 6: Drop old unique constraint
ALTER TABLE suppressions 
DROP CONSTRAINT suppressions_tenant_id_email_key;

-- Step 7: Add new unique constraint on motorical_account_id + email
ALTER TABLE suppressions 
ADD CONSTRAINT suppressions_customer_email_key 
UNIQUE(motorical_account_id, email);

-- Step 8: Add unique constraint on tenants.motorical_account_id if not exists
ALTER TABLE tenants 
ADD CONSTRAINT tenants_motorical_account_id_key 
UNIQUE(motorical_account_id);

-- Step 8b: Add foreign key constraint to tenants table
ALTER TABLE suppressions 
ADD CONSTRAINT suppressions_motorical_account_fkey 
FOREIGN KEY (motorical_account_id) 
REFERENCES tenants(motorical_account_id) 
ON DELETE CASCADE;

-- Step 9: Drop temporary index
DROP INDEX idx_suppressions_tenant_id_temp;

-- Step 10: Update indexes for optimal performance
CREATE INDEX idx_suppressions_customer_email ON suppressions(motorical_account_id, email);
CREATE INDEX idx_suppressions_email ON suppressions(email);

-- Step 11: Add migration metadata (if schema_migrations table exists)
-- INSERT INTO schema_migrations (version, applied_at) 
-- VALUES ('0002_customer_scoped_suppressions', NOW())
-- ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verification queries (run after migration)
-- SELECT COUNT(*) FROM suppressions WHERE motorical_account_id IS NOT NULL;
-- SELECT COUNT(DISTINCT motorical_account_id) FROM suppressions;
-- SELECT motorical_account_id, COUNT(*) FROM suppressions GROUP BY motorical_account_id;
