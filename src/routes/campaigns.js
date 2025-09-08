import express from 'express';
import { query } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';
import { registerWebhook } from './webhooks.js';

const router = express.Router();

function requireTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
  req.tenantId = tenantId;
  next();
}

router.post('/campaigns', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { name, template_id, list_ids, motor_block_id } = req.body || {};
    if (!name || !template_id || !Array.isArray(list_ids) || list_ids.length === 0 || !motor_block_id) {
      return res.status(400).json({ success: false, error: 'name, template_id, motor_block_id, list_ids[] required' });
    }
    const c = await query(
      `INSERT INTO campaigns (tenant_id, name, template_id, motor_block_id)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, template_id, motor_block_id, status, created_at`,
      [req.tenantId, name, template_id, motor_block_id]
    );
    const campaignId = c.rows[0].id;
    for (const lid of list_ids) {
      await query('INSERT INTO campaign_lists (campaign_id, list_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [campaignId, lid]);
    }
    // Attempt to auto-register webhook for this motor block (idempotent on provider side)
    try {
      const token = process.env.MOTORICAL_PUBLIC_API_TOKEN || '';
      const apiBase = process.env.MOTORICAL_API_BASE || 'https://api.motorical.com';
      const publicBase = process.env.COMM_PUBLIC_BASE || 'http://localhost:3011';
      const url = `${publicBase.replace(/\/$/, '')}/api/webhooks/motorical`;
      if (token) {
        await registerWebhook({ apiBase, token, motorBlockId: motor_block_id, url });
      }
    } catch (err) {
      // non-fatal
      console.warn('Webhook registration skipped/failed:', err?.message || err);
    }
    res.json({ success: true, data: c.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to create campaign' });
  }
});

router.patch('/campaigns/:id/settings', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { chunk_size, delay_seconds_between_chunks, timezone, scheduled_at, clear_scheduled } = req.body || {};
    // Keep original string; we'll cast in SQL ($3::timestamptz at time zone 'UTC')::timestamp
    let scheduledAtRaw = null;
    if (scheduled_at !== undefined) {
      let raw = scheduled_at;
      if (typeof raw === 'string') {
        raw = raw.trim();
        if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
          raw = raw.slice(1, -1);
        }
      }
      // Quick validation
      const d = new Date(raw);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid scheduled_at datetime' });
      }
      // Convert to PostgreSQL-compatible timestamp format (YYYY-MM-DD HH:MM:SS)
      scheduledAtRaw = d.toISOString().replace('T', ' ').replace('Z', '').substring(0, 19);
    }
    // Upsert send settings only when provided; when inserting, use DB defaults if null
    const cs = (chunk_size !== undefined && chunk_size !== null) ? parseInt(chunk_size) : null;
    const ds = (delay_seconds_between_chunks !== undefined && delay_seconds_between_chunks !== null) ? parseInt(delay_seconds_between_chunks) : null;
    // Ensure a row exists without relying on a unique constraint
    await query(
      `INSERT INTO campaign_send_settings (campaign_id, chunk_size, delay_seconds_between_chunks)
       SELECT $1, COALESCE($2, 100), COALESCE($3, 30)
       WHERE NOT EXISTS (SELECT 1 FROM campaign_send_settings WHERE campaign_id=$1)`,
      [req.params.id, Number.isFinite(cs) ? cs : null, Number.isFinite(ds) ? ds : null]
    );
    await query(
      `UPDATE campaign_send_settings
       SET chunk_size = COALESCE($2, chunk_size),
           delay_seconds_between_chunks = COALESCE($3, delay_seconds_between_chunks)
       WHERE campaign_id=$1`,
      [req.params.id, Number.isFinite(cs) ? cs : null, Number.isFinite(ds) ? ds : null]
    );
    // update tz/schedule on campaign
    if (clear_scheduled === true) {
      await query(
        `UPDATE campaigns SET timezone=COALESCE($2, timezone), scheduled_at=NULL WHERE id=$1 AND tenant_id=$3`,
        [req.params.id, timezone || null, req.tenantId]
      );
    } else {
      await query(
        `UPDATE campaigns 
         SET timezone=COALESCE($2, timezone),
             scheduled_at=COALESCE($3::timestamp, scheduled_at)
         WHERE id=$1 AND tenant_id=$4`,
        [req.params.id, timezone || null, scheduledAtRaw || null, req.tenantId]
      );
    }
    res.json({ success: true, message: 'Settings updated' });
  } catch (e) {
    console.error('Campaign settings update error:', e);
    res.status(500).json({ success: false, error: 'Failed to update settings', details: e.message });
  }
});

router.post('/campaigns/:id/schedule', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    await query('UPDATE campaigns SET status=\'scheduled\' WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Campaign scheduled' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to schedule campaign' });
  }
});

router.post('/campaigns/:id/cancel', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    await query('UPDATE campaigns SET status=\'cancelled\' WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Campaign cancelled' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to cancel campaign' });
  }
});

router.get('/campaigns', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const r = await query(`SELECT id, name, template_id, motor_block_id, status, 
                           CASE WHEN scheduled_at IS NOT NULL THEN to_char(scheduled_at::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') ELSE NULL END as scheduled_at, 
                           created_at FROM campaigns WHERE tenant_id=$1 ORDER BY created_at DESC`, [req.tenantId]);
    res.json({ success: true, data: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to fetch campaigns' });
  }
});

router.get('/campaigns/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const r = await query(`SELECT id, name, template_id, motor_block_id, status, timezone, 
                           CASE WHEN scheduled_at IS NOT NULL THEN to_char(scheduled_at::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') ELSE NULL END as scheduled_at, 
                           created_at FROM campaigns WHERE tenant_id=$1 AND id=$2`, [req.tenantId, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to fetch campaign' });
  }
});

// GET /api/campaigns/:id/events — granular per-send events (paginated)
router.get('/campaigns/:id/events', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const status = (req.query.status || '').trim().toLowerCase();

    // Ensure ownership
    const c = await query('SELECT id FROM campaigns WHERE id=$1 AND tenant_id=$2', [campaignId, req.tenantId]);
    if (c.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });

    const params = [campaignId];
    let where = 'campaign_id=$1';
    if (status) {
      params.push(status);
      where += ` AND type=$${params.length}`;
    }
    const totalQ = await query(`SELECT COUNT(*)::int AS count FROM email_events WHERE ${where}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const rows = await query(
      `SELECT id, type, message_id, contact_id, occurred_at, payload
       FROM email_events
       WHERE ${where}
       ORDER BY occurred_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ success: true, data: { items: rows.rows, total: totalQ.rows[0].count, page, pageSize } });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to fetch events' });
  }
});

router.delete('/campaigns/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    // Ensure campaign belongs to tenant
    const c = await query('SELECT id, status FROM campaigns WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (c.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });

    // Optional: prevent deletion if actively sending (basic safeguard)
    const status = c.rows[0].status;
    if (status === 'sending') {
      return res.status(409).json({ success: false, error: 'Cannot delete a campaign that is currently sending' });
    }

    // Cleanup dependents first (defensive)
    await query('DELETE FROM campaign_send_settings WHERE campaign_id=$1', [req.params.id]);
    await query('DELETE FROM campaign_lists WHERE campaign_id=$1', [req.params.id]);
    await query('DELETE FROM email_events WHERE campaign_id=$1', [req.params.id]);
    // Finally delete campaign
    await query('DELETE FROM campaigns WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);

    res.json({ success: true, message: 'Campaign deleted' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to delete campaign' });
  }
});

// GET /api/campaigns/:id/stats — totals from synced events (queued/sent/delivered/bounced)
router.get('/campaigns/:id/stats', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const campaignId = req.params.id;
    // Ensure campaign belongs to tenant
    const own = await query('SELECT motor_block_id FROM campaigns WHERE id=$1 AND tenant_id=$2', [campaignId, req.tenantId]);
    if (own.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });
    const mbId = own.rows[0].motor_block_id;

    const totals = {
      queued: 0,
      sending: 0,
      sent: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      failed: 0,
      blocked: 0
    };

    const API_BASE = process.env.MOTORICAL_API_BASE || 'https://api.motorical.com';
    const PUBLIC_TOKEN = process.env.MOTORICAL_PUBLIC_API_TOKEN || '';

    if (!PUBLIC_TOKEN) {
      return res.json({ success: true, data: { totals } });
    }

    // Pull recent logs and aggregate by campaign_id to mirror Analytics
    const resp = await fetch(`${API_BASE}/api/public/v1/motor-blocks/${encodeURIComponent(mbId)}/logs?limit=1000`, { headers: { Authorization: `Bearer ${PUBLIC_TOKEN}` } });
    if (resp.ok) {
      const data = await resp.json();
      const items = Array.isArray(data?.data?.items) ? data.data.items : [];
      for (const item of items) {
        let messageId = item?.messageId || item?.message_id || null;
        if (typeof messageId === 'string') messageId = messageId.trim().replace(/^<|>$/g, '');
        let campaignIdMeta = item?.metadata?.campaign_id || item?.metadata?.campaignId;
        if (!campaignIdMeta && messageId) {
          const map = await query('SELECT campaign_id FROM email_events WHERE message_id=$1 LIMIT 1', [messageId]);
          campaignIdMeta = map.rows[0]?.campaign_id || null;
        }
        if (String(campaignIdMeta) !== String(campaignId)) continue;

        const statusStr = String(item.status || item.classification || '').toLowerCase();
        if (statusStr.includes('deliver')) totals.delivered++;
        else if (statusStr.includes('accepted') || statusStr.includes('sent')) totals.sent++;
        else if (statusStr.includes('bounce')) totals.bounced++;
        else if (statusStr.includes('complain')) totals.complained++;
        else if (statusStr.includes('fail')) totals.failed++;
        else if (statusStr.includes('queue')) totals.queued++;
      }
    }

    const analyticsDelivered = (totals.delivered || 0) + (totals.sent || 0);
    res.json({ success: true, data: { totals: { ...totals, analyticsDelivered } } });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to fetch campaign stats' });
  }
});

// GET /api/campaigns/:id/analytics?days=7 — campaign-focused analytics (daily breakdown + recent activity)
router.get('/campaigns/:id/analytics', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days) || 7));
    const campaignId = req.params.id;
    const own = await query('SELECT motor_block_id FROM campaigns WHERE id=$1 AND tenant_id=$2', [campaignId, req.tenantId]);
    if (own.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });
    const mbId = own.rows[0].motor_block_id;

    // No longer need public API token since we query communications database directly

    // Get campaign email events directly from communications database
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const events = await query(`
      SELECT ee.*, c.email, c.name as contact_name 
      FROM email_events ee 
      LEFT JOIN contacts c ON c.id = ee.contact_id 
      WHERE ee.campaign_id = $1 AND ee.occurred_at >= $2 
      ORDER BY ee.occurred_at DESC
    `, [campaignId, cutoff]);
    
    const filtered = events.rows.map(event => ({
      messageId: event.message_id,
      status: event.type,
      classification: event.type,
      to: event.contact_id ? undefined : event.payload?.to || event.payload?.recipient,
      recipient: event.contact_id ? undefined : event.payload?.to || event.payload?.recipient,
      subject: event.payload?.subject || event.payload?.content?.subject,
      timestamp: event.occurred_at,
      metadata: {
        campaign_id: event.campaign_id,
        contact_id: event.contact_id,
        allRecipients: { to: [event.contact_id ? undefined : event.payload?.to] }
      },
      _ts: new Date(event.occurred_at).getTime()
    }));

    // Summary and classification mapping
    const summary = { totalEmails: filtered.length, deliveryRate: 0, acceptanceRate: 0, reputationScore: 100 };
    let delivered = 0, accepted = 0, failed = 0, hardBounce = 0, softBounce = 0;
    const classify = (s) => {
      const t = String(s || '').toLowerCase();
      if (t.includes('deliver')) return 'delivered';
      if (t.includes('accepted') || t.includes('sent')) return 'accepted';
      if (t.includes('hard')) return 'hard_bounce';
      if (t.includes('soft')) return 'soft_bounce';
      if (t.includes('bounce')) return 'hard_bounce';
      if (t.includes('fail')) return 'failed';
      return 'accepted';
    };

    const dailyBreakdown = {};
    for (const it of filtered) {
      const c = classify(it.status || it.classification);
      const day = new Date(it._ts).toISOString().split('T')[0];
      dailyBreakdown[day] = dailyBreakdown[day] || { accepted: 0, delivered: 0, hard_bounce: 0, soft_bounce: 0 };
      dailyBreakdown[day][c] = (dailyBreakdown[day][c] || 0) + 1;
      if (c === 'delivered') delivered++; else if (c === 'accepted') accepted++; else if (c === 'failed') failed++; else if (c === 'hard_bounce') hardBounce++; else if (c === 'soft_bounce') softBounce++;
    }
    summary.deliveryRate = filtered.length ? Math.round(((delivered + accepted) / filtered.length) * 100) : 0;
    summary.acceptanceRate = filtered.length ? Math.round((accepted / filtered.length) * 100) : 0;

    const recentActivity = events.rows
      .slice(0, 25)
      .map(event => ({
        classification: classify(event.type),
        toAddress: event.email || event.payload?.to || event.payload?.recipient || '',
        subject: event.payload?.subject || event.payload?.content?.subject || '',
        timestamp: event.occurred_at
      }));

    res.json({ success: true, data: { summary, dailyBreakdown, recentActivity } });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load campaign analytics' });
  }
});

// Get potential recipients for a campaign (including draft campaigns)
router.get('/campaigns/:id/recipients', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const campaignId = req.params.id;
    
    // Verify campaign ownership
    const own = await query('SELECT motor_block_id FROM campaigns WHERE id=$1 AND tenant_id=$2', [campaignId, req.tenantId]);
    if (own.rowCount === 0) return res.status(404).json({ success: false, error: 'Campaign not found' });

    // Get all potential recipients (same logic as sender worker)
    const candidates = await query(`
      SELECT c.id AS contact_id, c.email, c.name, c.identity_name, c.status as contact_status
      FROM campaign_lists cl
      JOIN list_contacts lc ON lc.list_id = cl.list_id AND lc.status='active'
      JOIN contacts c ON c.id = lc.contact_id AND c.status='active'
      JOIN tenants t ON t.id = c.tenant_id
      LEFT JOIN suppressions s ON s.motorical_account_id = t.motorical_account_id AND s.email = c.email
      WHERE cl.campaign_id=$1 AND c.tenant_id=$2 AND s.email IS NULL
    `, [campaignId, req.tenantId]);

    // Get already processed contacts
    const processed = await query(`
      SELECT DISTINCT contact_id FROM email_events WHERE campaign_id=$1
    `, [campaignId]);
    
    const processedSet = new Set(processed.rows.map(p => p.contact_id));
    
    // Deduplicate by email and filter out processed contacts
    const dedup = new Map();
    for (const row of candidates.rows) {
      const key = String(row.email).toLowerCase();
      const isProcessed = processedSet.has(row.contact_id);
      
      if (!dedup.has(key)) {
        dedup.set(key, {
          ...row,
          is_processed: isProcessed
        });
      }
    }
    
    const recipients = Array.from(dedup.values());
    const remaining = recipients.filter(r => !r.is_processed);
    
    res.json({ 
      success: true, 
      data: {
        total_potential: recipients.length,
        remaining: remaining.length,
        processed: recipients.length - remaining.length,
        recipients: recipients
      }
    });
  } catch (e) {
    console.error('Get campaign recipients error:', e);
    res.status(500).json({ success: false, error: 'Failed to load campaign recipients' });
  }
});

export default router;


