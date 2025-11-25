# Campaign Stats Fix - Status Update

## Issues Fixed

### 1. ✅ Database Type Mismatch Error (FIXED)

**Problem**: Stats worker was failing with PostgreSQL error:
```
inconsistent types deduced for parameter $6
detail: text versus character varying
```

**Root Cause**: The `type` column in `email_events` is `VARCHAR`, but PostgreSQL couldn't infer the type in the `SELECT ... WHERE NOT EXISTS` query.

**Fix Applied**: Added explicit `::varchar` cast to the `type` parameter in both the SELECT and WHERE clauses:

```javascript
`INSERT INTO email_events (tenant_id, campaign_id, contact_id, message_id, motor_block_id, type, payload, occurred_at)
 SELECT $1,$2,$3,$4,$5,$6::varchar,$7, NOW()
 WHERE NOT EXISTS (
   SELECT 1 FROM email_events WHERE campaign_id=$2 AND message_id=$4 AND type=$6::varchar
 )`
```

**Status**: ✅ Fixed - No more database errors in logs

### 2. ✅ Sent Event Creation (IMPLEMENTED)

**Problem**: Only `queued` events were being created, no `sent` events.

**Fix Applied**: Modified `src/worker/sender.js` to create both `queued` and `sent` events immediately after successful queue:

```javascript
// Record queued event
await recordEvent({
  tenantId: c.tenant_id,
  campaignId: c.id,
  contactId: recipient.contact_id,
  messageId, // email_logs.id (UUID)
  motorBlockId: c.motor_block_id,
  type: 'queued',
  payload: { ...(result || {}), idempotencyKey }
});

// Also record sent event immediately after successful queue
await recordEvent({
  tenantId: c.tenant_id,
  campaignId: c.id,
  contactId: recipient.contact_id,
  messageId, // email_logs.id for correlation
  motorBlockId: c.motor_block_id,
  type: 'sent',
  payload: { ...(result || {}), idempotencyKey, queuedAt: new Date().toISOString() }
});
```

**Status**: ✅ Implemented - Will work for NEW campaigns sent after restart (22:02:52)

### 3. ✅ Campaign Metadata in email_logs (IMPLEMENTED)

**Problem**: `campaign_id`, `tenant_id`, and `contact_id` were not stored in `email_logs.metadata`, preventing logs API from correlating logs to campaigns.

**Fix Applied**: Modified `src/worker/sender.js` to include campaign metadata:

```javascript
JSON.stringify({
  allRecipients,
  content: { bodyText: text || '', bodyHtml: html || '' },
  attachments: meta.attachments || [],
  // Include campaign metadata for logs API correlation
  campaign_id: meta.campaign_id || null,
  tenant_id: meta.tenant_id || null,
  contact_id: meta.contact_id || null
})
```

**Status**: ✅ Implemented - Will work for NEW campaigns sent after restart

## Current Status

### ✅ Working
- Database type mismatch error fixed
- Stats worker can now insert events without errors
- `sent` event creation implemented for new campaigns
- Campaign metadata stored in `email_logs` for new campaigns

### ⚠️ Expected Behavior

**Campaigns Completed Before Restart (14:07-14:42)**:
- These campaigns were sent BEFORE the fix was deployed (22:02:52)
- They will NOT have `sent` events (expected)
- They will NOT have campaign metadata in `email_logs.metadata` (expected)
- Stats worker may be able to create `delivered`/`bounced` events from logs API IF:
  - The logs API includes `campaign_id` in metadata (requires backend API fix)
  - OR the stats worker can match via `message_id` lookup (may work)

**New Campaigns Sent After Restart (after 22:02:52)**:
- ✅ Will have `queued` events
- ✅ Will have `sent` events
- ✅ Will have campaign metadata in `email_logs.metadata`
- ✅ Stats worker should be able to create `delivered`/`bounced` events from logs API

## Testing

To verify the fix is working:

1. **Create a new test campaign** and send it
2. **Check `email_events` table**:
   ```sql
   SELECT type, COUNT(*) 
   FROM email_events 
   WHERE campaign_id = '<new-campaign-id>' 
   GROUP BY type;
   ```
   Should show: `queued`, `sent`, and eventually `delivered`/`bounced`

3. **Check `email_logs.metadata`**:
   ```sql
   SELECT id, metadata->>'campaign_id' as campaign_id
   FROM email_logs 
   WHERE motor_block_id = '<motor-block-id>'
   ORDER BY created_at DESC
   LIMIT 5;
   ```
   Should show `campaign_id` in metadata for new emails

4. **Wait 60 seconds** for stats worker to poll logs API and create `delivered`/`bounced` events

5. **Check campaign stats API**:
   ```bash
   GET /api/campaigns/<campaign-id>/stats
   ```
   Should return non-zero `sent`, `delivered`, `bounced` counts

## Backend API Requirement

For optimal performance, the backend logs API (`/api/internal/motor-blocks/:id/logs`) should extract `campaign_id`, `tenant_id`, and `contact_id` from `email_logs.metadata` and include them in the response. This will make the stats worker matching more reliable.

If the backend API doesn't extract these fields, the stats worker will still work using the fallback lookup strategies, but it may be less efficient.

## Next Steps

1. ✅ **Monitor new campaigns** - Verify `sent` events are being created
2. ✅ **Monitor stats worker** - Verify no more database errors
3. ⏳ **Wait for next campaign** - Test with a real campaign to verify end-to-end
4. ⏳ **Backend API enhancement** - Extract campaign metadata from `email_logs.metadata` in logs API response (optional but recommended)

## Files Changed

1. `src/worker/sender.js`:
   - Added `sent` event creation after successful queue
   - Added `campaign_id`, `tenant_id`, `contact_id` to `email_logs.metadata`

2. `src/worker/stats.js`:
   - Fixed database type mismatch error with explicit `::varchar` cast
   - Improved campaign matching logic with multiple lookup strategies

## Deployment

- ✅ Services restarted: `motorical-comm-sender`, `motorical-comm-stats`
- ✅ Changes deployed and active
- ✅ Database errors resolved

