# Campaign Stats API Investigation - Root Cause Analysis

## Problem

Campaign completion emails show zero data even though emails were sent and received.

## Investigation Findings

### 1. Data Sources

**Communications Block Stats API** (`/api/campaigns/:id/stats`):
- Returns stats from `email_events` table in `communications_db`
- Structure: `{ totals: { sent, delivered, bounced, ... } }`

**Email Logs** (`email_logs` table in `motorical_db`):
- Contains actual email delivery records
- Campaign "Bingo5" has 24 emails in `email_logs` during campaign period
- But `email_logs` does NOT have `campaign_id` in metadata (all NULL)

### 2. Root Cause Identified

**The Communications Block sender worker is NOT creating delivery events in `email_events` table.**

Evidence:
- Campaign "Bingo5" (`5dca9307-5d23-459f-8c93-cc85c3c2016a`):
  - ✅ 24 emails in `email_logs` (21 delivered, 0 bounced)
  - ❌ Only 9 events in `email_events` (8 `queued`, 1 `clicked`)
  - ❌ **ZERO `sent` or `delivered` events**

- Campaign "Paķer Busu" (`715600a2-faf3-4909-b3a9-450673128183`):
  - ✅ Most recent completed campaign
  - ❌ Stats API returns all zeros

### 3. Expected Behavior

The Communications Block sender worker should:
1. Create `queued` event when email is queued ✅ (working)
2. Create `sent` event when email is sent ❌ (missing)
3. Create `delivered` event when email is delivered ❌ (missing)
4. Create `bounced` event when email bounces ❌ (missing)

### 4. Where Events Should Be Created

Events should be created by:
- **Communications Block sender worker** - when emails are sent
- **Email delivery engine** - when delivery status changes (delivered, bounced)
- **Analytics service** - when opens/clicks are tracked

### 5. Next Steps

1. **Check Communications Block sender worker code** (on mail host)
   - Verify it creates `sent` events in `email_events` table
   - Check if it's properly connected to `communications_db`

2. **Check Email delivery engine integration**
   - Verify it creates `delivered`/`bounced` events for campaign emails
   - Check if it has access to `campaign_id` to link events

3. **Check Analytics service**
   - Verify it creates `clicked` events (we see 1 clicked event, so this might be working)
   - Check if it creates `opened` events

## Current Status

- ✅ Stats API endpoint exists and works
- ✅ Stats API queries correct table (`email_events`)
- ❌ Events are NOT being created by sender/delivery engine
- ❌ Stats API returns zeros because no events exist

## Fix Required

The Communications Block sender worker and/or email delivery engine needs to be updated to create events in `email_events` table when emails are sent/delivered/bounced.

