import 'dotenv/config';
import pino from 'pino';
import { query } from '../db.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const API_BASE = process.env.MOTORICAL_API_BASE || 'https://api.motorical.com';
const PUBLIC_TOKEN = process.env.MOTORICAL_PUBLIC_API_TOKEN || '';

async function fetchJson(path) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: PUBLIC_TOKEN ? { Authorization: `Bearer ${PUBLIC_TOKEN}` } : {}
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

// Poll public logs API for recent events and upsert into email_events
async function pollPublicLogsAndUpsert() {
  if (!PUBLIC_TOKEN) return; // skip if not configured
  // Find recent campaigns we care about
  const cr = await query(
    `SELECT id, tenant_id, motor_block_id, created_at FROM campaigns
     WHERE status IN ('scheduled','sending')
        OR (status = 'completed' AND created_at >= NOW() - INTERVAL '2 days')
     ORDER BY created_at DESC LIMIT 50`
  );
  for (const c of cr.rows) {
    try {
      const mbId = c.motor_block_id;
      const resp = await fetchJson(`/api/public/v1/motor-blocks/${encodeURIComponent(mbId)}/logs?limit=100`);
      const logs = Array.isArray(resp?.data?.items) ? resp.data.items : [];
      for (const item of logs) {
        let messageId = item?.messageId || item?.message_id || null;
        if (typeof messageId === 'string') messageId = messageId.trim().replace(/^<|>$/g, '');
        const contactId = item?.metadata?.contact_id || null;
        let campaignId = item?.metadata?.campaign_id || item?.metadata?.campaignId || null;
        // If metadata does not include campaign id, try to resolve via previously recorded queued event
        if (!campaignId && messageId) {
          const map = await query('SELECT campaign_id FROM email_events WHERE message_id=$1 LIMIT 1', [messageId]);
          campaignId = map.rows[0]?.campaign_id || null;
        }
        if (!campaignId || String(campaignId) !== String(c.id)) continue;
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
        await query(
          `INSERT INTO email_events (tenant_id, campaign_id, contact_id, message_id, motor_block_id, type, payload, occurred_at)
           SELECT $1,$2,$3,$4,$5,$6,$7, NOW()
           WHERE NOT EXISTS (
             SELECT 1 FROM email_events WHERE campaign_id=$2 AND message_id=$4 AND type=$6
           )`,
          [c.tenant_id, c.id, contactId || null, messageId, mbId, normalized, JSON.stringify(item)]
        );
      }
    } catch (err) {
      logger.warn({ campaignId: c.id, err: String(err?.message || err) }, 'logs poll failed');
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
  setInterval(tick, 15000);
}

main().catch((err) => {
  logger.error({ err }, 'stats worker crashed');
  process.exit(1);
});


