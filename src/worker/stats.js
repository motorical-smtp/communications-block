import 'dotenv/config';
import pino from 'pino';
import { query } from '../db.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const API_BASE = process.env.MOTORICAL_API_BASE || 'https://api.motorical.com';
const COMM_INTERNAL_TOKEN = process.env.COMM_INTERNAL_TOKEN || '';

async function fetchJson(path) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: COMM_INTERNAL_TOKEN ? { Authorization: `Bearer ${COMM_INTERNAL_TOKEN}` } : {}
  });
  if (!resp.ok) throw new Error(`fetch ${path} failed ${resp.status}`);
  return await resp.json();
}

async function syncCampaignTotals() {
  // MVP: compute totals from email_events for each active/sending campaign
  await query(
    `UPDATE campaigns c SET status='completed'
     WHERE status='sending' AND NOT EXISTS (
       SELECT 1 FROM campaign_lists cl JOIN list_contacts lc ON lc.list_id=cl.list_id
       WHERE cl.campaign_id=c.id AND lc.status='active'
     )`
  );
}

// Poll internal logs API for recent events and upsert into email_events
async function pollPublicLogsAndUpsert() {
  if (!COMM_INTERNAL_TOKEN) return; // skip if not configured
  // Find recent campaigns we care about
  const cr = await query(
    `SELECT id, tenant_id, motor_block_id, created_at FROM campaigns
     WHERE status IN ('scheduled','sending')
        OR (status = 'completed' AND created_at >= NOW() - INTERVAL '2 days')
     ORDER BY created_at DESC LIMIT 50`
  );
  
  // Group campaigns by motor_block_id to avoid duplicate API calls
  const campaignsByMotorBlock = new Map();
  for (const c of cr.rows) {
    const mbId = c.motor_block_id;
    if (!campaignsByMotorBlock.has(mbId)) {
      campaignsByMotorBlock.set(mbId, []);
    }
    campaignsByMotorBlock.get(mbId).push(c);
  }
  
  // Fetch logs once per motor block (not per campaign)
  for (const [mbId, campaigns] of campaignsByMotorBlock.entries()) {
    try {
      const resp = await fetchJson(`/api/internal/motor-blocks/${encodeURIComponent(mbId)}/logs?limit=100`);
      const logs = Array.isArray(resp?.data?.items) ? resp.data.items : [];
      
      // Process logs for all campaigns using this motor block
      for (const item of logs) {
        let messageId = item?.messageId || item?.message_id || item?.id || null;
        if (typeof messageId === 'string') messageId = messageId.trim().replace(/^<|>$/g, '');
        let contactId = item?.metadata?.contact_id || null;
        let campaignId = item?.metadata?.campaign_id || item?.metadata?.campaignId || null;
        
        // If metadata does not include campaign id, try multiple lookup strategies
        if (!campaignId && messageId) {
          // Strategy 1: Look up by messageId (could be email_logs.id UUID or Postfix message_id)
          const map = await query(
            `SELECT DISTINCT campaign_id, contact_id FROM email_events 
             WHERE message_id=$1 AND campaign_id IS NOT NULL 
             LIMIT 1`, 
            [messageId]
          );
          if (map.rows.length > 0) {
            campaignId = map.rows[0].campaign_id || null;
            // Also get contact_id from existing event if not in metadata
            if (!contactId) {
              contactId = map.rows[0].contact_id || null;
            }
          }
          
          // Strategy 2: If still not found and messageId looks like a UUID (email_logs.id),
          // try to find any event with this messageId (queued events use email_logs.id)
          if (!campaignId && messageId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
            const uuidMap = await query(
              `SELECT DISTINCT campaign_id, contact_id FROM email_events 
               WHERE message_id=$1 AND campaign_id IS NOT NULL 
               LIMIT 1`, 
              [messageId]
            );
            if (uuidMap.rows.length > 0) {
              campaignId = uuidMap.rows[0].campaign_id || null;
              if (!contactId) {
                contactId = uuidMap.rows[0].contact_id || null;
              }
            }
          }
          
          // Strategy 3: If still no contact_id, try to find it from any queued event with this message_id
          if (!contactId && messageId) {
            const contactMap = await query(
              `SELECT contact_id FROM email_events 
               WHERE message_id=$1 AND contact_id IS NOT NULL 
               ORDER BY occurred_at ASC 
               LIMIT 1`, 
              [messageId]
            );
            if (contactMap.rows.length > 0) {
              contactId = contactMap.rows[0].contact_id || null;
            }
          }
        }
        
        // Find which campaign(s) this log entry belongs to
        const matchingCampaigns = campaigns.filter(c => campaignId && String(campaignId) === String(c.id));
        
        // Process for each matching campaign
        for (const c of matchingCampaigns) {
          const normalized = (() => {
            const t = String(item.status || '').toLowerCase();
            if (t.includes('deliver')) return 'delivered';
            if (t.includes('bounce')) return 'bounced';
            if (t.includes('complain')) return 'complained';
            if (t.includes('fail')) return 'failed';
            if (t.includes('send') || t.includes('accept')) return 'sent';
            return 'sent';
          })();
          // Insert if not already present for this message and type
          // Cast type to VARCHAR to match column type
          // Use contact_id from lookup if available
          await query(
            `INSERT INTO email_events (tenant_id, campaign_id, contact_id, message_id, motor_block_id, type, payload, occurred_at)
             SELECT $1,$2,$3,$4,$5,$6::varchar,$7, NOW()
             WHERE NOT EXISTS (
               SELECT 1 FROM email_events WHERE campaign_id=$2 AND message_id=$4 AND type=$6::varchar
             )`,
            [c.tenant_id, c.id, contactId || null, messageId, mbId, String(normalized), JSON.stringify(item)]
          );
        }
      }
    } catch (err) {
      logger.warn({ motorBlockId: mbId, err: String(err?.message || err) }, 'logs poll failed');
    }
  }
}

async function tick() {
  try {
    await syncCampaignTotals();
    await pollPublicLogsAndUpsert();
  } catch (err) {
    logger.error({ err }, 'stats tick error');
  }
}

async function main() {
  logger.info('communications-block stats worker started');
  setInterval(() => logger.info('stats worker heartbeat'), 60000);
  // Poll every 60 seconds instead of 15 seconds to reduce API load
  // For active campaigns, this is still frequent enough for real-time updates
  setInterval(tick, 60000);
}

main().catch((err) => {
  logger.error({ err }, 'stats worker crashed');
  process.exit(1);
});


