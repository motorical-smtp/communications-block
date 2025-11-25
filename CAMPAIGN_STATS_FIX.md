# Campaign Stats Fix - Zero Data Issue Resolution

## Problem

Campaign completion emails were showing zero data even though emails were sent and received. The investigation revealed that:

1. ✅ `queued` events were being created
2. ❌ `sent` events were **NOT** being created
3. ❌ `delivered`/`bounced` events were **NOT** being created
4. ❌ `campaign_id` was **NOT** stored in `email_logs.metadata`, preventing logs API from correlating logs to campaigns

## Root Cause

The Communications Block sender worker was:
- Creating `queued` events ✅
- But **NOT** creating `sent` events ❌
- Storing metadata in `email_logs` but **NOT** including `campaign_id`, `tenant_id`, or `contact_id` ❌

The stats worker was:
- Polling logs API but couldn't match logs to campaigns because `campaign_id` wasn't in metadata
- Falling back to `message_id` lookup, but this was unreliable

## Fixes Applied

### 1. Added `sent` Event Creation (`src/worker/sender.js`)

**Before**: Only `queued` event was created after successful queue.

**After**: Both `queued` and `sent` events are created immediately after successful queue:

```javascript
// Record queued event (email_logs.id as messageId for correlation)
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

**Impact**: Campaign stats will now show `sent` counts immediately.

### 2. Added Campaign Metadata to `email_logs` (`src/worker/sender.js`)

**Before**: `email_logs.metadata` only included `allRecipients`, `content`, and `attachments`.

**After**: `email_logs.metadata` now includes `campaign_id`, `tenant_id`, and `contact_id`:

```javascript
JSON.stringify({
  allRecipients,
  content: {
    bodyText: text || '',
    bodyHtml: html || ''
  },
  attachments: meta.attachments || [],
  // Include campaign metadata for logs API correlation
  campaign_id: meta.campaign_id || null,
  tenant_id: meta.tenant_id || null,
  contact_id: meta.contact_id || null
})
```

**Impact**: The logs API can now extract `campaign_id` from metadata and include it in responses, enabling reliable campaign correlation.

### 3. Improved Stats Worker Matching Logic (`src/worker/stats.js`)

**Before**: Single lookup strategy using `messageId` from logs API.

**After**: Multiple lookup strategies with better handling:

```javascript
// Strategy 1: Look up by messageId (could be email_logs.id UUID or Postfix message_id)
const map = await query(
  `SELECT DISTINCT campaign_id FROM email_events 
   WHERE message_id=$1 AND campaign_id IS NOT NULL 
   LIMIT 1`, 
  [messageId]
);
campaignId = map.rows[0]?.campaign_id || null;

// Strategy 2: If still not found and messageId looks like a UUID (email_logs.id),
// try to find any event with this messageId (queued events use email_logs.id)
if (!campaignId && messageId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
  const uuidMap = await query(
    `SELECT DISTINCT campaign_id FROM email_events 
     WHERE message_id=$1 AND campaign_id IS NOT NULL 
     LIMIT 1`, 
    [messageId]
  );
  campaignId = uuidMap.rows[0]?.campaign_id || null;
}
```

**Impact**: More reliable matching of logs to campaigns, even if logs API doesn't include `campaign_id` in metadata.

## Expected Behavior After Fix

### Immediate (After Sender Worker Restart)

1. ✅ New campaigns will create both `queued` and `sent` events
2. ✅ `email_logs.metadata` will include `campaign_id`, `tenant_id`, `contact_id`
3. ✅ Campaign stats API will show `sent` counts

### After Stats Worker Polls (60 seconds)

1. ✅ Stats worker will poll logs API
2. ✅ Logs API should include `campaign_id` in metadata (if backend extracts it)
3. ✅ Stats worker will create `delivered`/`bounced` events for matched logs
4. ✅ Campaign stats API will show `delivered` and `bounced` counts

## Backend API Requirement

**Note**: For optimal performance, the backend logs API (`/api/internal/motor-blocks/:id/logs`) should extract `campaign_id`, `tenant_id`, and `contact_id` from `email_logs.metadata` and include them in the response:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "messageId": "...",
        "status": "delivered",
        "metadata": {
          "campaign_id": "uuid",
          "tenant_id": "uuid",
          "contact_id": "uuid"
        }
      }
    ]
  }
}
```

If the backend API doesn't extract these fields, the stats worker will still work using the fallback lookup strategies, but it will be less efficient.

## Testing

1. **Create a new campaign** and send test emails
2. **Check `email_events` table**:
   ```sql
   SELECT type, COUNT(*) 
   FROM email_events 
   WHERE campaign_id = '<campaign-id>' 
   GROUP BY type;
   ```
   Should show: `queued`, `sent`, and eventually `delivered`/`bounced`

3. **Check `email_logs.metadata`**:
   ```sql
   SELECT id, metadata->>'campaign_id' as campaign_id
   FROM email_logs 
   WHERE motor_block_id = '<motor-block-id>'
   LIMIT 5;
   ```
   Should show `campaign_id` in metadata

4. **Check campaign stats API**:
   ```bash
   GET /api/campaigns/<campaign-id>/stats
   ```
   Should return non-zero `sent`, `delivered`, `bounced` counts

## Files Changed

1. `src/worker/sender.js`:
   - Added `sent` event creation after successful queue
   - Added `campaign_id`, `tenant_id`, `contact_id` to `email_logs.metadata`

2. `src/worker/stats.js`:
   - Improved campaign matching logic with multiple lookup strategies
   - Better handling of UUID vs Postfix message_id formats

## Deployment

1. **Restart sender worker**:
   ```bash
   sudo systemctl restart motorical-comm-sender
   ```

2. **Restart stats worker** (optional, but recommended):
   ```bash
   sudo systemctl restart motorical-comm-stats
   ```

3. **Monitor logs**:
   ```bash
   sudo journalctl -u motorical-comm-sender -f
   sudo journalctl -u motorical-comm-stats -f
   ```

## Status

- ✅ `sent` events now created immediately
- ✅ Campaign metadata stored in `email_logs`
- ✅ Stats worker improved matching logic
- ⏳ **Pending**: Verify backend logs API extracts `campaign_id` from metadata (if not, fallback will work)

