-- Migration: 0011_add_unsubscribe_events.sql
-- Date: 2025-12-11
-- Purpose: Add unsubscribe_events table for analytics and GDPR compliance

BEGIN;

-- Create unsubscribe_events table
CREATE TABLE IF NOT EXISTS unsubscribe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  source VARCHAR(50) NOT NULL DEFAULT 'link',
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_unsubscribe_events_tenant ON unsubscribe_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_unsubscribe_events_email ON unsubscribe_events(email);
CREATE INDEX IF NOT EXISTS idx_unsubscribe_events_campaign ON unsubscribe_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_unsubscribe_events_created ON unsubscribe_events(created_at DESC);

-- Add consent tracking columns to contacts if not exists
ALTER TABLE contacts 
  ADD COLUMN IF NOT EXISTS consent_given_at TIMESTAMP WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS consent_source VARCHAR(50);

-- Create index for consent queries
CREATE INDEX IF NOT EXISTS idx_contacts_consent ON contacts(tenant_id, consent_given_at);

COMMIT;
