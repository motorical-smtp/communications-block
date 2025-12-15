-- Audit logs table for tracking CSV uploads and other security events
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL, -- e.g., 'csv_upload', 'csv_upload_blocked', 'rate_limit_exceeded'
  action VARCHAR(50) NOT NULL, -- e.g., 'import', 'blocked', 'failed'
  resource_type VARCHAR(50), -- e.g., 'list', 'contact'
  resource_id UUID, -- e.g., list_id
  user_identifier VARCHAR(255), -- IP address, user ID, etc.
  details JSONB, -- Additional context (file size, row count, error details, etc.)
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_event ON audit_logs(tenant_id, event_type, created_at);

-- Grant permissions
GRANT ALL PRIVILEGES ON audit_logs TO motorical;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO motorical;

