import express from 'express';
import crypto from 'crypto';
import { query } from '../db.js';

const router = express.Router();

function verifySignature(bodyString, headerSig, secret) {
  if (!secret) return true; // optional in MVP
  try {
    const h = crypto.createHmac('sha256', secret).update(bodyString).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(String(headerSig || ''), 'hex'));
  } catch (_) {
    return false;
  }
}

async function resolveTenantId({ tenant_id, campaign_id }) {
  if (tenant_id) return tenant_id;
  if (campaign_id) {
    const r = await query('SELECT tenant_id FROM campaigns WHERE id=$1', [campaign_id]);
    if (r.rowCount > 0) return r.rows[0].tenant_id;
  }
  return null;
}

router.post('/api/webhooks/motorical', express.json({ limit: '1mb' }), async (req, res) => {
  const secret = process.env.COMM_WEBHOOK_SECRET || '';
  const headerSig = req.headers['x-motorical-signature'] || req.headers['x-motorical-signature'.toLowerCase()];
  const bodyStr = JSON.stringify(req.body || {});
  if (!verifySignature(bodyStr, headerSig, secret)) {
    return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  try {
    const evt = req.body || {};
    const type = String(evt.type || '').toLowerCase();
    const campaignId = evt.campaign_id || null;
    const contactId = evt.contact_id || null;
    const messageId = evt.message_id || null;
    const motorBlockId = evt.motor_block_id || null;
    const occurredAt = evt.occurred_at ? new Date(evt.occurred_at) : new Date();
    const tenantId = await resolveTenantId({ tenant_id: evt.tenant_id, campaign_id: campaignId });

    if (!tenantId) return res.status(202).json({ success: true, message: 'No tenant resolved; accepted' });

    let normalized;
    if (type.includes('deliver')) normalized = 'delivered';
    else if (type.includes('bounce')) normalized = 'bounced';
    else if (type.includes('complain')) normalized = 'complained';
    else if (type.includes('sent')) normalized = 'sent';
    else normalized = 'sent';

    await query(
      `INSERT INTO email_events (tenant_id, campaign_id, contact_id, message_id, motor_block_id, type, payload, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, campaignId, contactId, messageId, motorBlockId, normalized, JSON.stringify(evt), occurredAt]
    );

    if (normalized === 'bounced') {
      if (contactId) await query(`UPDATE contacts SET status='bounced', updated_at=NOW() WHERE id=$1 AND tenant_id=$2`, [contactId, tenantId]);
    }
    if (normalized === 'complained') {
      if (contactId) await query(`UPDATE contacts SET status='complained', updated_at=NOW() WHERE id=$1 AND tenant_id=$2`, [contactId, tenantId]);
    }

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Webhook handling failed' });
  }
});

export default router;

// Optional: helper to register webhooks with Motorical Public API for a tenant's motor block
// This can be invoked by provisioning or an admin tool.
export async function registerWebhook({ apiBase, token, motorBlockId, url, events }) {
  const res = await fetch(`${apiBase || 'https://api.motorical.com'}/api/public/v1/motor-blocks/${encodeURIComponent(motorBlockId)}/webhooks`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url, events: events || ['sent','delivered','bounced','complained','failed'] })
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>'');
    throw new Error(`registerWebhook failed ${res.status} ${t}`);
  }
  return await res.json();
}


