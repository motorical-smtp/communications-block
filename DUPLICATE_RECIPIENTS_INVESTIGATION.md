# Duplicate Recipients Investigation

## Problem
Campaign recipients list shows each recipient twice in the frontend, even though email logs show single sends.

## Root Cause ✅ FIXED
The Communications Block sender worker was creating **both `queued` and `sent` events immediately** when sending emails, causing duplicate events in the `email_events` table.

### Evidence
1. **Database had duplicates**: Multiple event types created for same recipient at send time
2. **Analytics API returned duplicates**: Because database had duplicate events
   - Example: `girtsliepins@icloud.com` appeared twice with `classification: "accepted"`
   - Example: `info@autoroad.lv` appeared twice
   - Example: `liepinsgirts+reputation@gmail.com` appeared twice

### Test Results (Before Fix)
```bash
# Check for duplicates in analytics API
curl -s -H "X-Tenant-Id: 857b6868-b804-4bbb-87ee-b8fceb2e37f1" \
  http://10.66.66.1:3011/api/campaigns/fb013848-5f71-4cc4-a759-e331db2272d5/analytics?days=30 | \
  jq '.data.recentActivity | group_by(.toAddress) | map({email: .[0].toAddress, count: length}) | .[] | select(.count > 1)'

# Result: Multiple recipients appeared 2 times each
```

## Fix Applied ✅
**Location**: Communications Block sender worker (on mail host)

**Before**: 
- Sender worker created both `queued` and `sent` events immediately → causing duplicates

**After**: 
- Sender worker only creates `queued` events
- Stats worker creates `sent`/`delivered`/`bounced` events when polling the logs API (every 60 seconds)

### What to Expect
- **New campaigns**: Only `queued` events created initially
- **After stats worker polls (60 seconds)**: `sent`/`delivered`/`bounced` events created from logs API
- **No more duplicate recipients** in the frontend

## Status
✅ **FIXED** - Both issues resolved:

### Issue 1: Duplicate Event Creation ✅ FIXED
- Sender worker now only creates `queued` events
- No more duplicate `sent` events created immediately

### Issue 2: Stats Worker Not Populating `contact_id` ✅ FIXED
**Problem**: The stats worker was creating `sent` events from the logs API but **didn't populate `contact_id`**, causing:
- `sent` events couldn't be associated with recipients
- Analytics API showed more events than recipients (e.g., 11 events for 6 recipients)
- Frontend displayed duplicate-looking entries because `sent` events weren't properly linked

**Fix Applied**: Modified `src/worker/stats.js` to look up `contact_id` from existing `queued` events:
1. When processing logs API items, first try to get `contact_id` from metadata ✅
2. If not in metadata, look up existing events by `message_id` and extract `contact_id` ✅
3. Use the found `contact_id` when creating `sent`/`delivered`/`bounced` events ✅

**Code Changes**:
- Updated campaign lookup queries to also return `contact_id`
- Added fallback lookup to find `contact_id` from any existing event with matching `message_id`
- Ensures `sent` events are properly linked to recipients

**Example from campaign `5662eea3-53c9-4a74-96ad-6af4413a598f` (before fix):**
- 6 `queued` events (all have `contact_id`) ✅
- 5 `sent` events (all have NULL `contact_id`) ❌

**Expected after fix:**
- 6 `queued` events (all have `contact_id`) ✅
- 5 `sent` events (all have `contact_id` from `queued` events) ✅

## Frontend
The frontend Map-based deduplication handles event aggregation correctly. No changes needed.

