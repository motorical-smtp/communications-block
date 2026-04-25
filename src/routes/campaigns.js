import express from 'express';
import { query, pool } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';
import { registerWebhook } from './webhooks.js';
import { getLatestArtifact, getLatestAudienceSnapshot } from '../repo/compile.js';
import { executeHooks } from '../services/compile-hooks.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const router = express.Router();

function requireTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
  req.tenantId = tenantId;
  next();
}

function compactArtifact(artifact) {
  if (!artifact) return null;
  return {
    id: artifact.id,
    campaign_id: artifact.campaign_id,
    version: artifact.version,
    subject: artifact.subject,
    created_at: artifact.created_at,
    has_html: Boolean(artifact.html_compiled),
    has_text: Boolean(artifact.text_compiled),
    html_size: artifact.html_compiled ? Buffer.byteLength(String(artifact.html_compiled), 'utf8') : 0,
    text_size: artifact.text_compiled ? String(artifact.text_compiled).length : 0,
    metrics: artifact.meta?.security?.metrics || artifact.meta?.metrics || null
  };
}

router.post('/campaigns', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { name, template_id, list_ids, motor_block_id, google_analytics, from_address, from_name } = req.body || {};
    if (!name || !template_id || !Array.isArray(list_ids) || list_ids.length === 0 || !motor_block_id) {
      return res.status(400).json({ success: false, error: 'name, template_id, motor_block_id, list_ids[] required' });
    }
    
    // Prepare Google Analytics settings with defaults
    const gaSettings = {
      enabled: false,
      ...google_analytics
    };
    
    // Validate from_address format if provided
    if (from_address && typeof from_address === 'string' && from_address.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(from_address.trim())) {
        return res.status(400).json({ success: false, error: 'Invalid from_address format. Must be a valid email address.' });
      }
    }
    
    const c = await query(
      `INSERT INTO campaigns (tenant_id, name, template_id, motor_block_id, google_analytics, from_address, from_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, template_id, motor_block_id, status, created_at, google_analytics, from_address, from_name`,
      [req.tenantId, name, template_id, motor_block_id, JSON.stringify(gaSettings), from_address?.trim() || null, from_name?.trim() || null]
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
    const { chunk_size, delay_seconds_between_chunks, timezone, scheduled_at, clear_scheduled, from_address, from_name } = req.body || {};
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
    // Validate from_address format if provided
    if (from_address !== undefined && from_address !== null) {
      if (typeof from_address === 'string' && from_address.trim()) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(from_address.trim())) {
          return res.status(400).json({ success: false, error: 'Invalid from_address format. Must be a valid email address.' });
        }
      } else if (from_address !== null) {
        return res.status(400).json({ success: false, error: 'Invalid from_address format. Must be a valid email address or null.' });
      }
    }
    
    // update tz/schedule/from_address/from_name on campaign
    if (clear_scheduled === true) {
      await query(
        `UPDATE campaigns 
         SET timezone=COALESCE($2, timezone), 
             scheduled_at=NULL,
             from_address=COALESCE($4, from_address),
             from_name=COALESCE($5, from_name)
         WHERE id=$1 AND tenant_id=$3`,
        [req.params.id, timezone || null, req.tenantId, from_address !== undefined ? (from_address?.trim() || null) : undefined, from_name !== undefined ? (from_name?.trim() || null) : undefined]
      );
    } else {
      await query(
        `UPDATE campaigns 
         SET timezone=COALESCE($2, timezone),
             scheduled_at=COALESCE($3::timestamp, scheduled_at),
             from_address=COALESCE($5, from_address),
             from_name=COALESCE($6, from_name)
         WHERE id=$1 AND tenant_id=$4`,
        [req.params.id, timezone || null, scheduledAtRaw || null, req.tenantId, from_address !== undefined ? (from_address?.trim() || null) : undefined, from_name !== undefined ? (from_name?.trim() || null) : undefined]
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

// GET /api/campaigns/deleted - List soft-deleted campaigns for potential restoration
router.get('/campaigns/deleted', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const r = await query(`SELECT id, name, template_id, motor_block_id, status, 
                           deleted_at, created_at 
                           FROM campaigns 
                           WHERE tenant_id=$1 AND deleted_at IS NOT NULL 
                           ORDER BY deleted_at DESC 
                           LIMIT 50`, [req.tenantId]);
    
    res.json({ success: true, data: r.rows });
  } catch (e) {
    logger.error({ error: e, tenantId: req.tenantId }, 'Failed to fetch deleted campaigns');
    res.status(500).json({ success: false, error: 'Failed to fetch deleted campaigns' });
  }
});

router.get('/campaigns', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const compact = String(req.query.compact || 'false') === 'true';
    const r = await query(`SELECT c.id, c.name, c.template_id, c.motor_block_id, c.status, c.google_analytics, c.from_address, c.from_name,
                           CASE WHEN c.scheduled_at IS NOT NULL THEN to_char(c.scheduled_at::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') ELSE NULL END as scheduled_at, 
                           c.created_at,
                           COALESCE(css.chunk_size, 100) as chunk_size,
                           COALESCE(css.delay_seconds_between_chunks, 30) as delay_seconds_between_chunks
                           FROM campaigns c
                           LEFT JOIN campaign_send_settings css ON css.campaign_id = c.id
                           WHERE c.tenant_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC`, [req.tenantId]);
    
    // Enrich with latest artifacts and snapshots for each campaign
    const enrichedCampaigns = await Promise.all(r.rows.map(async (campaign) => {
      const latestArtifact = await getLatestArtifact(campaign.id, req.tenantId);
      const latestSnapshot = await getLatestAudienceSnapshot(campaign.id, req.tenantId);
      if (compact) {
        return { ...campaign, latestArtifact: compactArtifact(latestArtifact), latestSnapshot };
      }
      return { ...campaign, latestArtifact, latestSnapshot };
    }));
    
    res.json({ success: true, data: enrichedCampaigns });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to fetch campaigns' });
  }
});

router.get('/campaigns/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const r = await query(`SELECT id, name, template_id, motor_block_id, status, google_analytics, timezone, from_address, from_name,
                           CASE WHEN scheduled_at IS NOT NULL THEN to_char(scheduled_at::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') ELSE NULL END as scheduled_at, 
                           created_at FROM campaigns WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`, [req.tenantId, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });
    // Attach latest compile info (if any)
    const latestArtifact = await getLatestArtifact(req.params.id, req.tenantId);
    const latestSnapshot = await getLatestAudienceSnapshot(req.params.id, req.tenantId);
    res.json({ success: true, data: { ...r.rows[0], latestArtifact, latestSnapshot } });
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
    const c = await query('SELECT id FROM campaigns WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [campaignId, req.tenantId]);
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
    // Ensure campaign belongs to tenant and is not already soft-deleted
    const c = await query('SELECT id, status FROM campaigns WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [req.params.id, req.tenantId]);
    if (c.rowCount === 0) return res.status(404).json({ success: false, error: 'Campaign not found or already deleted' });

    // Optional: prevent deletion if actively sending (basic safeguard)
    const status = c.rows[0].status;
    if (status === 'sending') {
      return res.status(409).json({ success: false, error: 'Cannot delete a campaign that is currently sending' });
    }

    // Soft delete: set deleted_at timestamp instead of hard delete
    await query('UPDATE campaigns SET deleted_at = NOW() WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);

    logger.info({ campaignId: req.params.id, tenantId: req.tenantId }, 'Campaign soft deleted');
    res.json({ success: true, message: 'Campaign deleted successfully' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to delete campaign' });
  }
});

// PATCH /api/campaigns/:id/restore - Restore a soft-deleted campaign
router.patch('/campaigns/:id/restore', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    // Ensure campaign belongs to tenant and is soft-deleted
    const c = await query('SELECT id, status FROM campaigns WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NOT NULL', [req.params.id, req.tenantId]);
    if (c.rowCount === 0) return res.status(404).json({ success: false, error: 'Campaign not found or not deleted' });

    // Restore campaign: clear deleted_at timestamp
    await query('UPDATE campaigns SET deleted_at = NULL WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);

    logger.info({ campaignId: req.params.id, tenantId: req.tenantId }, 'Campaign restored from soft delete');
    res.json({ success: true, message: 'Campaign restored successfully' });
  } catch (e) {
    logger.error({ error: e, campaignId: req.params.id, tenantId: req.tenantId }, 'Failed to restore campaign');
    res.status(500).json({ success: false, error: 'Failed to restore campaign' });
  }
});

// DELETE /api/campaigns/:id/permanent - Permanently delete a soft-deleted campaign (hard delete)
router.delete('/campaigns/:id/permanent', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    // Ensure campaign belongs to tenant and is soft-deleted
    const c = await query('SELECT id, status, name FROM campaigns WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NOT NULL', [req.params.id, req.tenantId]);
    if (c.rowCount === 0) return res.status(404).json({ success: false, error: 'Campaign not found in recycle bin' });

    const campaignName = c.rows[0].name;

    // Hard delete: Remove all related data (CASCADE will handle most relationships)
    await query('DELETE FROM campaign_send_settings WHERE campaign_id=$1', [req.params.id]);
    await query('DELETE FROM campaign_lists WHERE campaign_id=$1', [req.params.id]);
    await query('DELETE FROM comm_audience_snapshots WHERE campaign_id=$1', [req.params.id]);
    await query('DELETE FROM comm_campaign_artifacts WHERE campaign_id=$1', [req.params.id]);
    await query('DELETE FROM email_events WHERE campaign_id=$1', [req.params.id]);
    
    // Finally delete the campaign itself
    await query('DELETE FROM campaigns WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);

    logger.info({ campaignId: req.params.id, tenantId: req.tenantId, campaignName }, 'Campaign permanently deleted');
    res.json({ success: true, message: 'Campaign permanently deleted' });
  } catch (e) {
    logger.error({ error: e, campaignId: req.params.id, tenantId: req.tenantId }, 'Failed to permanently delete campaign');
    res.status(500).json({ success: false, error: 'Failed to permanently delete campaign' });
  }
});

// DELETE /api/campaigns/cleanup - Bulk permanent delete of all soft-deleted campaigns
router.delete('/campaigns/cleanup', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { olderThanDays = 30 } = req.body || {};
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    // Get campaigns to be permanently deleted
    const campaignsToDelete = await query(
      'SELECT id, name FROM campaigns WHERE tenant_id=$1 AND deleted_at IS NOT NULL AND deleted_at < $2',
      [req.tenantId, cutoffDate.toISOString()]
    );

    if (campaignsToDelete.rowCount === 0) {
      return res.json({ 
        success: true, 
        message: 'No campaigns found for cleanup',
        deleted_count: 0 
      });
    }

    const campaignIds = campaignsToDelete.rows.map(c => c.id);
    const campaignNames = campaignsToDelete.rows.map(c => c.name);

    // Batch delete related data
    for (const campaignId of campaignIds) {
      await query('DELETE FROM campaign_send_settings WHERE campaign_id=$1', [campaignId]);
      await query('DELETE FROM campaign_lists WHERE campaign_id=$1', [campaignId]);
      await query('DELETE FROM comm_audience_snapshots WHERE campaign_id=$1', [campaignId]);
      await query('DELETE FROM comm_campaign_artifacts WHERE campaign_id=$1', [campaignId]);
      await query('DELETE FROM email_events WHERE campaign_id=$1', [campaignId]);
    }

    // Delete the campaigns themselves
    await query(
      'DELETE FROM campaigns WHERE tenant_id=$1 AND deleted_at IS NOT NULL AND deleted_at < $2',
      [req.tenantId, cutoffDate.toISOString()]
    );

    logger.info({ 
      tenantId: req.tenantId, 
      deletedCount: campaignsToDelete.rowCount,
      campaignNames,
      olderThanDays 
    }, 'Bulk campaign cleanup completed');

    res.json({ 
      success: true, 
      message: `Permanently deleted ${campaignsToDelete.rowCount} campaigns`,
      deleted_count: campaignsToDelete.rowCount,
      deleted_campaigns: campaignNames
    });
  } catch (e) {
    logger.error({ error: e, tenantId: req.tenantId }, 'Failed to cleanup campaigns');
    res.status(500).json({ success: false, error: 'Failed to cleanup campaigns' });
  }
});

// GET /api/campaigns/:id/stats — totals from synced events (queued/sent/delivered/bounced/opened/clicked)
router.get('/campaigns/:id/stats', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const campaignId = req.params.id;
    // Ensure campaign belongs to tenant
    const own = await query('SELECT motor_block_id FROM campaigns WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [campaignId, req.tenantId]);
    if (own.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });

    // Query email_events table directly to get accurate counts
    const eventsResult = await query(
      `SELECT type, COUNT(*) as count 
       FROM email_events 
       WHERE campaign_id = $1 AND tenant_id = $2 
       GROUP BY type`,
      [campaignId, req.tenantId]
    );

    const totals = {
      queued: 0,
      sending: 0,
      sent: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      failed: 0,
      blocked: 0,
      opened: 0,
      clicked: 0
    };

    // Map event types to totals
    eventsResult.rows.forEach(row => {
      const type = String(row.type).toLowerCase();
      const count = parseInt(row.count) || 0;
      
      if (type === 'queued') totals.queued = count;
      else if (type === 'sending') totals.sending = count;
      else if (type === 'sent') totals.sent = count;
      else if (type === 'delivered') totals.delivered = count;
      else if (type === 'bounced') totals.bounced = count;
      else if (type === 'complained') totals.complained = count;
      else if (type === 'failed') totals.failed = count;
      else if (type === 'blocked') totals.blocked = count;
      else if (type === 'opened') totals.opened = count;
      else if (type === 'clicked') totals.clicked = count;
    });

    // Derive roll-up metrics expected by unified messaging / completion email service
    const distinctResult = await query(
      `SELECT COUNT(DISTINCT message_id) AS total
       FROM email_events
       WHERE campaign_id = $1 AND tenant_id = $2
         AND message_id IS NOT NULL`,
      [campaignId, req.tenantId]
    );

    const totalSent = parseInt(distinctResult.rows?.[0]?.total, 10) || 0;
    const deliveredCount = totals.delivered || 0;
    const bouncedCount = totals.bounced || 0;
    const openedCount = totals.opened || 0;
    const clickedCount = totals.clicked || 0;

    const pct = (num, denom) => {
      if (!denom || denom <= 0) return 0;
      return Math.round((num / denom) * 100);
    };

    const deliveryRate = pct(deliveredCount, totalSent);
    const openRate = pct(openedCount, totalSent);
    const clickRate = pct(clickedCount, totalSent);

    const analyticsDelivered = (totals.delivered || 0) + (totals.sent || 0);

    res.json({
      success: true,
      data: {
        totals: { ...totals, analyticsDelivered },
        total_sent: totalSent,
        delivered: deliveredCount,
        bounced: bouncedCount,
        opened: openedCount,
        clicked: clickedCount,
        delivery_rate: deliveryRate,
        open_rate: openRate,
        click_rate: clickRate
      }
    });
  } catch (e) {
    console.error('Campaign stats error:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch campaign stats', details: e.message });
  }
});

// GET /api/campaigns/:id/click-breakdown - Get click analytics by URL
router.get('/campaigns/:id/click-breakdown', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const campaignId = req.params.id;
    
    // Verify campaign belongs to tenant
    const own = await query('SELECT id FROM campaigns WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [campaignId, req.tenantId]);
    if (own.rowCount === 0) return res.status(404).json({ success: false, error: 'Campaign not found' });

    // Get click events grouped by URL
    const clicksResult = await query(`
      SELECT 
        payload->>'url' as url,
        COUNT(*) as total_clicks,
        COUNT(DISTINCT contact_id) as unique_clicks
      FROM email_events
      WHERE campaign_id = $1 
        AND tenant_id = $2 
        AND type = 'clicked'
        AND payload ? 'url'
      GROUP BY payload->>'url'
      ORDER BY total_clicks DESC
    `, [campaignId, req.tenantId]);

    res.json({
      success: true,
      data: clicksResult.rows.map(row => ({
        url: row.url,
        total_clicks: parseInt(row.total_clicks) || 0,
        unique_clicks: parseInt(row.unique_clicks) || 0
      }))
    });
  } catch (e) {
    console.error('Click breakdown error:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch click breakdown' });
  }
});

// GET /api/campaigns/:id/analytics?days=7 — campaign-focused analytics (daily breakdown + recent activity)
router.get('/campaigns/:id/analytics', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days) || 7));
    const campaignId = req.params.id;
    const own = await query('SELECT motor_block_id FROM campaigns WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [campaignId, req.tenantId]);
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

    // Summary and classification mapping - enhanced with click tracking
    const summary = { totalEmails: filtered.length, deliveryRate: 0, acceptanceRate: 0, clickRate: 0, reputationScore: 100 };
    let delivered = 0, accepted = 0, failed = 0, hardBounce = 0, softBounce = 0, clicked = 0;
    const classify = (s) => {
      const t = String(s || '').toLowerCase();
      if (t.includes('click')) return 'clicked';
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
      dailyBreakdown[day] = dailyBreakdown[day] || { accepted: 0, delivered: 0, hard_bounce: 0, soft_bounce: 0, clicked: 0 };
      dailyBreakdown[day][c] = (dailyBreakdown[day][c] || 0) + 1;
      if (c === 'delivered') delivered++; 
      else if (c === 'accepted') accepted++; 
      else if (c === 'clicked') clicked++; 
      else if (c === 'failed') failed++; 
      else if (c === 'hard_bounce') hardBounce++; 
      else if (c === 'soft_bounce') softBounce++;
    }
    summary.deliveryRate = filtered.length ? Math.round(((delivered + accepted) / filtered.length) * 100) : 0;
    summary.acceptanceRate = filtered.length ? Math.round((accepted / filtered.length) * 100) : 0;
    summary.clickRate = delivered > 0 ? Math.round((clicked / delivered) * 100) : 0;
    summary.totalClicks = clicked;
    
    // Get unique clickers
    const uniqueClickers = new Set();
    events.rows.forEach(event => {
      if (event.type === 'clicked' && event.contact_id) {
        uniqueClickers.add(event.contact_id);
      }
    });
    summary.uniqueClickers = uniqueClickers.size;

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
    const own = await query('SELECT motor_block_id FROM campaigns WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [campaignId, req.tenantId]);
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

// Compile-before-send endpoint
router.post('/campaigns/:id/compile', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const campaignId = req.params.id;
    // Validate campaign and ownership
    const c = await query(
      'SELECT c.id, c.tenant_id, c.template_id, c.status, c.google_analytics, t.name as template_name, t.subject, t.body_html, t.body_text\n       FROM campaigns c JOIN templates t ON t.id=c.template_id\n       WHERE c.id=$1 AND c.tenant_id=$2 AND c.deleted_at IS NULL',
      [campaignId, req.tenantId]
    );
    if (c.rowCount === 0) return res.status(404).json({ success: false, error: 'Campaign not found' });

    // Determine next version
    const vq = await query('SELECT COALESCE(MAX(version),0)+1 as next FROM comm_campaign_artifacts WHERE campaign_id=$1', [campaignId]);
    const version = vq.rows?.[0]?.next || 1;

    // Basic HTML processing placeholder (sanitize/inlining/tracking will be added next phases)
    const subject = c.rows[0].subject || '';
    const htmlCompiled = c.rows[0].body_html || '';
    const textCompiled = c.rows[0].body_text || '';

    // Compute audience at compile time using current recipient logic
    const recipientsQ = await query(`
      SELECT DISTINCT LOWER(c.email) AS email
      FROM campaign_lists cl
      JOIN list_contacts lc ON lc.list_id = cl.list_id AND lc.status='active'
      JOIN contacts c ON c.id = lc.contact_id AND c.status='active'
      JOIN tenants tt ON tt.id = c.tenant_id
      LEFT JOIN suppressions s ON s.motorical_account_id = tt.motorical_account_id AND s.email = c.email
      WHERE cl.campaign_id=$1 AND c.tenant_id=$2 AND s.email IS NULL
    `, [campaignId, req.tenantId]);
    const totalRecipients = recipientsQ.rowCount || 0;

    // Insert artifact and audience snapshot in a transaction (single connection)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO comm_campaign_artifacts (tenant_id, campaign_id, version, subject, html_compiled, text_compiled, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.tenantId, campaignId, version, subject, htmlCompiled, textCompiled, JSON.stringify({ compiled_at: new Date().toISOString() })]
      );
      await client.query(
        `INSERT INTO comm_audience_snapshots (tenant_id, campaign_id, version, total_recipients, included_lists, deduped_by, filters)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.tenantId, campaignId, version, totalRecipients, null, 'email', null]
      );

      // Pre-commit security validation
      const securityContext = {
        type: 'compile.validation',
        campaignId,
        tenantId: req.tenantId,
        version,
        artifact: { subject, htmlCompiled, textCompiled }
      };

      try {
        const { executeHooks } = await import('../services/compile-hooks.js');
        const validationResults = await executeHooks('compile.validation', securityContext);
        const securityResult = validationResults.find(r => r.hook === 'security-validation');
        
        if (securityResult?.success && !securityResult.result?.validated) {
          // Security validation failed - rollback and reject
          await client.query('ROLLBACK');
          client.release();
          return res.status(400).json({
            success: false,
            error: 'Security validation failed',
            details: {
              errors: securityResult.result.errors,
              warnings: securityResult.result.warnings
            }
          });
        }

        // Store security metrics in artifact metadata if validation passed
        if (securityResult?.success && (securityResult.result?.warnings?.length > 0 || securityResult.result?.metrics)) {
          const { warnings, metrics } = securityResult.result;
          const metaUpdate = {
            security: {
              metrics,
              warnings,
              validatedAt: new Date().toISOString()
            }
          };
          
          await client.query(
            'UPDATE comm_campaign_artifacts SET meta = COALESCE(meta, \'{}\') || $1::jsonb WHERE campaign_id = $2 AND version = $3',
            [JSON.stringify(metaUpdate), campaignId, version]
          );
        }
      } catch (validationError) {
        logger.warn({ campaignId, error: validationError.message }, 'Security validation hook failed');
        // Continue with compilation - don't block on hook failures
      }

      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }

    // Execute post-compile hooks and update artifact with processed content
    const campaign = c.rows[0];
    // Google Analytics validation and warnings
    const gaWarnings = [];
    if (campaign.google_analytics?.enabled) {
      logger.info({ campaignId, tenantId: req.tenantId }, 'Google Analytics enabled - UTM parameters will be added to links');
      
      // Add important warning about landing page requirements
      gaWarnings.push({
        type: 'ga_landing_page_requirement',
        title: 'Google Analytics Landing Page Setup Required',
        message: 'UTM parameters will be added to your links, but your landing pages must have Google Analytics tracking installed to capture this data.',
        recommendation: 'Ensure all destination URLs have Google Analytics (gtag.js or GA4) properly configured with your Measurement ID.',
        severity: 'warning',
        action_required: true
      });
      
      // Check if external domain links are being used
      if (htmlCompiled && (htmlCompiled.includes('href="http') || htmlCompiled.includes("href='http"))) {
        gaWarnings.push({
          type: 'ga_domain_verification',
          title: 'Verify Google Analytics on All Landing Domains',
          message: 'Links point to external domains. Verify Google Analytics is installed on all destination websites.',
          recommendation: 'Test UTM parameter tracking on your landing pages before sending the campaign.',
          severity: 'info'
        });
      }
    }

    const hookContext = {
      type: 'compile.completed',
      campaignId,
      tenantId: req.tenantId,
      version,
      totalRecipients,
      campaign: {
        id: campaign.id,
        name: campaign.template_name,
        google_analytics: campaign.google_analytics
      },
      artifact: { subject, htmlCompiled, textCompiled },
      ga_warnings: gaWarnings
    };
    
    try {
      const hookResults = await executeHooks('compile.completed', hookContext);
      
      // Check if link processing updated the HTML content
      const linkProcessingResult = hookResults.find(r => r.hook === 'link-processing');
      if (linkProcessingResult?.success && linkProcessingResult.result?.trackingApplied) {
        // Import link processor to get the processed HTML
        const { processHtmlLinks } = await import('../services/link-processor.js');
        const { processedHtml } = await processHtmlLinks(htmlCompiled, {
          campaignId,
          version,
          utmPolicy: 'preserve'
        });
        
        // Update artifact with processed HTML containing tracking links
        if (processedHtml !== htmlCompiled) {
          await query(
            'UPDATE comm_campaign_artifacts SET html_compiled = $1 WHERE campaign_id = $2 AND version = $3',
            [processedHtml, campaignId, version]
          );
          logger.info({ campaignId, version }, 'Artifact updated with processed links');
        }
      }
    } catch (hookError) {
      console.warn('Post-compile hooks failed:', hookError);
    }

    res.json({ 
      success: true, 
      data: { 
        version, 
        totalRecipients,
        ga_warnings: gaWarnings.length > 0 ? gaWarnings : undefined
      } 
    });
  } catch (e) {
    console.error('Compile error:', e);
    res.status(500).json({ success: false, error: 'Failed to compile campaign', details: e.message });
  }
});


