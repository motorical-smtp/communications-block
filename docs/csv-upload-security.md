# CSV Upload Backend Security Implementation

## Overview

This document describes the backend security measures implemented for CSV file uploads in the Communications Service, complementing the frontend protections.

## Implemented Security Measures

### 1. File Size Limits ✅
- **Limit**: 10MB (increased from 5MB)
- **Implementation**: Multer middleware configuration
- **Location**: `src/routes/lists.js` line 352
- **Enforcement**: Automatic rejection of files exceeding 10MB before processing

### 2. Rate Limiting ✅
- **Limit**: 10 uploads per 15 minutes per tenant
- **Implementation**: Redis-based rate limiting middleware
- **Location**: `src/middleware/csvRateLimiter.js`
- **Features**:
  - Per-tenant rate limiting (isolated by tenant ID)
  - Redis-backed with automatic expiration
  - Rate limit headers in responses (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`)
  - Graceful degradation if Redis is unavailable (allows request but logs warning)
- **Response**: HTTP 429 with retry information when limit exceeded

### 3. Server-Side CSV Injection Validation ✅
- **Implementation**: Comprehensive pattern detection utility
- **Location**: `src/utils/csvInjectionValidator.js`
- **Detected Patterns**:
  - Formula injection: `=`, `@`, `+`, `-` at start of cell
  - Command injection: `cmd|`, `powershell|`, `|`, `&`, `` ` ``, `$()`
  - HTML-like tags
  - Null byte injection
  - Dangerous Excel functions: `HYPERLINK`, `WEBSERVICE`, `IMPORTXML`, etc.
- **Validation**: Per-cell and per-row validation with violation reporting
- **Response**: HTTP 400 with detailed violation information when threats detected

### 4. Authentication/Authorization Checks ✅
- **Tenant Verification**: `requireTenant` middleware validates `X-Tenant-Id` header
- **Entitlement Check**: `requireEntitledTenant` middleware verifies:
  - Tenant exists in database
  - Tenant status is 'active'
  - Tenant has valid subscription
- **List Ownership**: Explicit check that list belongs to tenant before import
- **Location**: `src/routes/lists.js` lines 369-374, 398-408
- **Response**: HTTP 403 for unauthorized access

### 5. Audit Logging ✅
- **Implementation**: Database-backed audit log table
- **Location**: 
  - Migration: `migrations/0010_add_audit_logs.sql`
  - Logging function: `src/routes/lists.js` lines 354-367
- **Logged Events**:
  - Successful imports (with statistics)
  - Blocked uploads (with reason)
  - Failed uploads (with error details)
  - Rate limit violations
  - CSV injection attempts
  - Authorization failures
- **Data Captured**:
  - Tenant ID
  - Event type (`csv_upload`, `csv_upload_blocked`, etc.)
  - Action (`imported`, `blocked`, `failed`, `validated`)
  - Resource type and ID
  - User identifier (IP address)
  - Details (file size, row count, violations, errors, etc.)
  - Timestamp

## Database Schema

### Audit Logs Table
```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50),
  resource_id UUID,
  user_identifier VARCHAR(255),
  details JSONB,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
```

**Indexes**:
- `idx_audit_logs_tenant_id` - Fast tenant lookups
- `idx_audit_logs_event_type` - Event type filtering
- `idx_audit_logs_created_at` - Time-based queries
- `idx_audit_logs_tenant_event` - Composite for common queries

## API Endpoint

### POST `/api/lists/:id/contacts/import`

**Middleware Chain**:
1. `requireTenant` - Validates tenant header
2. `requireEntitledTenant` - Verifies tenant entitlement
3. `csvUploadRateLimiter` - Enforces rate limits
4. `upload.single('file')` - Handles file upload (10MB limit)
5. Handler - Processes CSV with validation

**Request**:
- Method: POST
- Headers: `X-Tenant-Id: <uuid>`
- Content-Type: `multipart/form-data`
- Body: Form field `file` containing CSV file
- Query: `?dryRun=true|false` (optional)

**Response Examples**:

**Success**:
```json
{
  "success": true,
  "data": {
    "processed": 100,
    "added": 85,
    "upserts": 10,
    "errors": 5,
    "errorSamples": [...]
  }
}
```

**Rate Limit Exceeded**:
```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "message": "Maximum 10 CSV uploads per 15 minutes. Please try again later.",
  "retryAfter": 900
}
```

**CSV Injection Detected**:
```json
{
  "success": false,
  "error": "CSV injection detected",
  "message": "Found 3 potential security threat(s) in CSV data...",
  "violations": [
    {
      "column": "name",
      "value": "=cmd|/c calc",
      "reason": "csv_injection_pattern",
      "row": 5
    }
  ],
  "violationCount": 3
}
```

**Unauthorized**:
```json
{
  "success": false,
  "error": "List not found or access denied"
}
```

## Deployment Steps

### 1. Run Database Migration
```bash
cd /root/motoric_smtp/communications-block
sudo -u postgres psql -d communications_db -f migrations/0010_add_audit_logs.sql
```

### 2. Verify Redis Connection
Ensure Redis is accessible with the configured credentials:
```bash
# Test Redis connection
redis-cli -h $REDIS_HOST -p $REDIS_PORT -a $REDIS_PASSWORD ping
```

### 3. Restart Service
```bash
sudo systemctl restart motorical-comm-api
sudo systemctl status motorical-comm-api
```

### 4. Verify Logs
```bash
sudo journalctl -u motorical-comm-api -f
```

## Testing

### Test Rate Limiting
```bash
# Make 11 rapid requests (should fail on 11th)
for i in {1..11}; do
  curl -H "X-Tenant-Id: $TENANT_ID" \
       -F "file=@test.csv" \
       "http://localhost:3011/api/lists/$LIST_ID/contacts/import"
  echo "Request $i completed"
done
```

### Test CSV Injection Detection
Create a test CSV with injection patterns:
```csv
email,name,phone
test@example.com,=cmd|/c calc,1234567890
user@example.com,@SUM(A1:A10),0987654321
```

Expected: HTTP 400 with violation details

### Test File Size Limit
```bash
# Create a 11MB file
dd if=/dev/zero of=large.csv bs=1M count=11

# Attempt upload
curl -H "X-Tenant-Id: $TENANT_ID" \
     -F "file=@large.csv" \
     "http://localhost:3011/api/lists/$LIST_ID/contacts/import"
```

Expected: HTTP 413 (Request Entity Too Large) from Multer

### Test Authorization
```bash
# Attempt to import to another tenant's list
curl -H "X-Tenant-Id: $OTHER_TENANT_ID" \
     -F "file=@test.csv" \
     "http://localhost:3011/api/lists/$LIST_ID/contacts/import"
```

Expected: HTTP 403

### Verify Audit Logs
```sql
-- View recent CSV upload events
SELECT event_type, action, resource_id, user_identifier, details, created_at
FROM audit_logs
WHERE event_type = 'csv_upload'
ORDER BY created_at DESC
LIMIT 20;

-- View blocked uploads
SELECT event_type, action, details->>'reason' as reason, created_at
FROM audit_logs
WHERE action = 'blocked'
ORDER BY created_at DESC;
```

## Security Considerations

1. **Defense in Depth**: Multiple layers of protection (frontend + backend)
2. **Fail-Safe Defaults**: Rate limiter allows requests if Redis fails (with logging)
3. **Comprehensive Logging**: All security events are logged for forensics
4. **Tenant Isolation**: Rate limiting and authorization are tenant-scoped
5. **Input Validation**: CSV content validated before database operations
6. **Error Handling**: Detailed error messages for debugging without exposing internals

## Monitoring Recommendations

1. **Rate Limit Violations**: Monitor `audit_logs` for `action='blocked'` with `details->>'reason'='rate_limit_exceeded'`
2. **CSV Injection Attempts**: Alert on `csv_injection_detected` events
3. **Failed Imports**: Track `action='failed'` events for system health
4. **Large Files**: Monitor file sizes in audit logs to detect abuse patterns

## Future Enhancements

- User-based rate limiting (in addition to tenant-based)
- Configurable rate limits per tenant tier
- Enhanced CSV injection patterns based on threat intelligence
- Automated alerting for suspicious patterns
- CSV sanitization (removing dangerous characters) as alternative to rejection

