-- Rollback script for Customer-Scoped Suppressions Migration
-- Use this to rollback if migration causes issues

-- Rollback: 0002_customer_scoped_suppressions.sql
-- Date: 2024-12-15
-- Purpose: Rollback customer-scoped suppressions to tenant-scoped

BEGIN;

-- Step 1: Drop new indexes
DROP INDEX IF EXISTS idx_suppressions_customer_email;
DROP INDEX IF EXISTS idx_suppressions_email;

-- Step 2: Drop new foreign key constraint
ALTER TABLE suppressions 
DROP CONSTRAINT IF EXISTS suppressions_motorical_account_fkey;

-- Step 2b: Drop unique constraint on tenants.motorical_account_id
ALTER TABLE tenants 
DROP CONSTRAINT IF EXISTS tenants_motorical_account_id_key;

-- Step 3: Drop new unique constraint
ALTER TABLE suppressions 
DROP CONSTRAINT IF EXISTS suppressions_customer_email_key;

-- Step 4: Restore old unique constraint
ALTER TABLE suppressions 
ADD CONSTRAINT suppressions_tenant_id_email_key 
UNIQUE(tenant_id, email);

-- Step 5: Remove motorical_account_id column
ALTER TABLE suppressions 
DROP COLUMN IF EXISTS motorical_account_id;

-- Step 6: Remove migration metadata (if schema_migrations table exists)
-- DELETE FROM schema_migrations WHERE version = '0002_customer_scoped_suppressions';

COMMIT;

-- Verification after rollback
-- SELECT COUNT(*) FROM suppressions;
-- \d suppressions
