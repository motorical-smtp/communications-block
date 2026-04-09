import express from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';
import pino from 'pino';

const router = express.Router();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const JWT_SECRET = process.env.SERVICE_JWT_SECRET || 'comm-block-secret-change-me';
const COMM_PUBLIC_BASE = process.env.COMM_PUBLIC_BASE || 'http://localhost:3011';

/**
 * Sign a JWT token for click tracking
 */
export function signClickToken({ tenantId, campaignId, contactId, originalUrl, linkIndex, ttl = '90d' }) {
  const payload = {
    type: 'click',
    tid: tenantId,
    cid: campaignId,
    uid: contactId,
    url: originalUrl,
    idx: linkIndex
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ttl });
}

/**
 * Sign a JWT token for unsubscribe
 */
export function signUnsubscribeToken({ tenantId, campaignId, contactId, ttl = '30d' }) {
  const payload = {
    type: 'unsubscribe',
    tid: tenantId,
    cid: campaignId,
    uid: contactId
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ttl });
}

/**
 * Verify and decode a tracking token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    logger.warn({ error: error.message }, 'Token verification failed');
    return null;
  }
}

// Helper to get tenant from header
function requireTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
  req.tenantId = tenantId;
  next();
}

// GET /api/tracking/events - Comprehensive tracking events explorer
router.get('/events', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const {
      campaign_id,
      contact_email,
      event_type,      // sent, delivered, opened, clicked, bounced, unsubscribed, complained
      date_from,
      date_to,
      limit = 100,
      offset = 0,
      sort_by = 'occurred_at',
      sort_order = 'desc'
    } = req.query;

    const tenantId = req.tenantId;

    // Parse array params for multi-select filters
    const parseArrayParam = (param) => {
      if (!param || param === '') return [];
      if (Array.isArray(param)) return param;
      if (typeof param === 'string' && param.includes(',')) {
        return param.split(',').map(v => v.trim()).filter(v => v);
      }
      return param;
    };

    const eventTypeArray = parseArrayParam(event_type);
    const campaignIdArray = parseArrayParam(campaign_id);

    // Build WHERE conditions
    const conditions = ['ee.tenant_id = $1'];
    const params = [tenantId];
    let paramCount = 1;

    // Event type filter
    if (eventTypeArray && (Array.isArray(eventTypeArray) ? eventTypeArray.length > 0 : eventTypeArray)) {
      paramCount++;
      if (Array.isArray(eventTypeArray) && eventTypeArray.length > 0) {
        conditions.push(`ee.type = ANY($${paramCount})`);
        params.push(eventTypeArray);
      } else {
        conditions.push(`ee.type = $${paramCount}`);
        params.push(eventTypeArray);
      }
    }

    // Campaign filter
    if (campaignIdArray && (Array.isArray(campaignIdArray) ? campaignIdArray.length > 0 : campaignIdArray)) {
      paramCount++;
      if (Array.isArray(campaignIdArray) && campaignIdArray.length > 0) {
        conditions.push(`ee.campaign_id = ANY($${paramCount})`);
        params.push(campaignIdArray);
      } else {
        conditions.push(`ee.campaign_id = $${paramCount}`);
        params.push(campaignIdArray);
      }
    }

    // Contact email filter
    if (contact_email) {
      paramCount++;
      conditions.push(`c.email ILIKE '%' || $${paramCount} || '%'`);
      params.push(contact_email);
    }

    // Date range filters
    if (date_from) {
      paramCount++;
      conditions.push(`ee.occurred_at >= $${paramCount}`);
      params.push(date_from);
    }

    if (date_to) {
      paramCount++;
      conditions.push(`ee.occurred_at <= $${paramCount}`);
      params.push(date_to);
    }

    const whereClause = conditions.join(' AND ');

    // Sortable columns
    const validSortColumns = {
      'occurred_at': 'ee.occurred_at',
      'type': 'ee.type',
      'contact_email': 'c.email',
      'campaign_name': 'cam.name'
    };

    const sortColumn = validSortColumns[sort_by] || validSortColumns['occurred_at'];
    const sortDirection = ['asc', 'desc'].includes(sort_order?.toLowerCase()) ? sort_order.toUpperCase() : 'DESC';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM email_events ee
      LEFT JOIN contacts c ON ee.contact_id = c.id
      WHERE ${whereClause}
    `;
    const countResult = await query(countQuery, params);
    const total = parseInt(countResult.rows[0]?.total || 0);

    // Get events with pagination
    paramCount++;
    const limitParam = paramCount;
    params.push(parseInt(limit));
    
    paramCount++;
    const offsetParam = paramCount;
    params.push(parseInt(offset));

    const eventsQuery = `
      SELECT 
        ee.id,
        ee.type,
        ee.occurred_at,
        ee.payload,
        c.email as contact_email,
        c.name as contact_name,
        cam.name as campaign_name,
        cam.id as campaign_id
      FROM email_events ee
      LEFT JOIN contacts c ON ee.contact_id = c.id
      LEFT JOIN campaigns cam ON ee.campaign_id = cam.id
      WHERE ${whereClause}
      ORDER BY ${sortColumn} ${sortDirection}
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const eventsResult = await query(eventsQuery, params);

    res.json({
      success: true,
      data: {
        events: eventsResult.rows,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    logger.error({ error, tenantId: req.tenantId }, 'Failed to fetch tracking events');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve tracking events' 
    });
  }
});

// GET /api/tracking/export - Export tracking events as CSV
router.get('/export', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const {
      campaign_id,
      contact_email,
      event_type,
      date_from,
      date_to
    } = req.query;

    const tenantId = req.tenantId;

    // Parse array params
    const parseArrayParam = (param) => {
      if (!param || param === '') return [];
      if (Array.isArray(param)) return param;
      if (typeof param === 'string' && param.includes(',')) {
        return param.split(',').map(v => v.trim()).filter(v => v);
      }
      return param;
    };

    const eventTypeArray = parseArrayParam(event_type);
    const campaignIdArray = parseArrayParam(campaign_id);

    // Build WHERE conditions (same as events endpoint)
    const conditions = ['ee.tenant_id = $1'];
    const params = [tenantId];
    let paramCount = 1;

    if (eventTypeArray && (Array.isArray(eventTypeArray) ? eventTypeArray.length > 0 : eventTypeArray)) {
      paramCount++;
      if (Array.isArray(eventTypeArray) && eventTypeArray.length > 0) {
        conditions.push(`ee.type = ANY($${paramCount})`);
        params.push(eventTypeArray);
      } else {
        conditions.push(`ee.type = $${paramCount}`);
        params.push(eventTypeArray);
      }
    }

    if (campaignIdArray && (Array.isArray(campaignIdArray) ? campaignIdArray.length > 0 : campaignIdArray)) {
      paramCount++;
      if (Array.isArray(campaignIdArray) && campaignIdArray.length > 0) {
        conditions.push(`ee.campaign_id = ANY($${paramCount})`);
        params.push(campaignIdArray);
      } else {
        conditions.push(`ee.campaign_id = $${paramCount}`);
        params.push(campaignIdArray);
      }
    }

    if (contact_email) {
      paramCount++;
      conditions.push(`c.email ILIKE '%' || $${paramCount} || '%'`);
      params.push(contact_email);
    }

    if (date_from) {
      paramCount++;
      conditions.push(`ee.occurred_at >= $${paramCount}`);
      params.push(date_from);
    }

    if (date_to) {
      paramCount++;
      conditions.push(`ee.occurred_at <= $${paramCount}`);
      params.push(date_to);
    }

    const whereClause = conditions.join(' AND ');

    // Fetch all events (no pagination for export)
    const exportQuery = `
      SELECT 
        ee.type as event_type,
        ee.occurred_at,
        c.email as contact_email,
        c.name as contact_name,
        cam.name as campaign_name,
        ee.payload->>'url' as clicked_url,
        ee.payload->>'reason' as bounce_reason,
        ee.payload->>'smtp_code' as smtp_code
      FROM email_events ee
      LEFT JOIN contacts c ON ee.contact_id = c.id
      LEFT JOIN campaigns cam ON ee.campaign_id = cam.id
      WHERE ${whereClause}
      ORDER BY ee.occurred_at DESC
      LIMIT 10000
    `;

    const result = await query(exportQuery, params);

    // Generate CSV
    const csvRows = [];
    
    // CSV Header
    csvRows.push('Event Type,Occurred At,Contact Email,Contact Name,Campaign Name,Clicked URL,Bounce Reason,SMTP Code');

    // CSV Data
    result.rows.forEach(row => {
      const csvRow = [
        row.event_type || '',
        row.occurred_at ? new Date(row.occurred_at).toISOString() : '',
        row.contact_email || '',
        row.contact_name || '',
        row.campaign_name || '',
        row.clicked_url || '',
        row.bounce_reason || '',
        row.smtp_code || ''
      ].map(field => {
        // Escape quotes and wrap in quotes if contains comma, quote, or newline
        const stringField = String(field);
        if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
          return `"${stringField.replace(/"/g, '""')}"`;
        }
        return stringField;
      });
      
      csvRows.push(csvRow.join(','));
    });

    const csv = csvRows.join('\n');
    const timestamp = new Date().toISOString().split('T')[0];
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tracking-events-${timestamp}.csv"`);
    res.send('\uFEFF' + csv); // UTF-8 BOM for Excel compatibility
  } catch (error) {
    logger.error({ error, tenantId: req.tenantId }, 'Failed to export tracking events');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to export tracking events' 
    });
  }
});

// GET /api/tracking/stats - Tracking statistics summary with filter support
router.get('/stats', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const {
      campaign_id,
      contact_email,
      event_type,
      date_from,
      date_to,
      days = 30
    } = req.query;
    
    const tenantId = req.tenantId;

    // Parse array params
    const parseArrayParam = (param) => {
      if (!param || param === '') return [];
      if (Array.isArray(param)) return param;
      if (typeof param === 'string' && param.includes(',')) {
        return param.split(',').map(v => v.trim()).filter(v => v);
      }
      return param;
    };

    const eventTypeArray = parseArrayParam(event_type);
    const campaignIdArray = parseArrayParam(campaign_id);

    // Build WHERE conditions
    const conditions = ['ee.tenant_id = $1'];
    const params = [tenantId];
    let paramCount = 1;

    // Event type filter
    if (eventTypeArray && (Array.isArray(eventTypeArray) ? eventTypeArray.length > 0 : eventTypeArray)) {
      paramCount++;
      if (Array.isArray(eventTypeArray) && eventTypeArray.length > 0) {
        conditions.push(`ee.type = ANY($${paramCount})`);
        params.push(eventTypeArray);
      } else {
        conditions.push(`ee.type = $${paramCount}`);
        params.push(eventTypeArray);
      }
    }

    // Campaign filter
    if (campaignIdArray && (Array.isArray(campaignIdArray) ? campaignIdArray.length > 0 : campaignIdArray)) {
      paramCount++;
      if (Array.isArray(campaignIdArray) && campaignIdArray.length > 0) {
        conditions.push(`ee.campaign_id = ANY($${paramCount})`);
        params.push(campaignIdArray);
      } else {
        conditions.push(`ee.campaign_id = $${paramCount}`);
        params.push(campaignIdArray);
      }
    }

    // Contact email filter
    if (contact_email) {
      paramCount++;
      conditions.push(`EXISTS (
        SELECT 1 FROM contacts c 
        WHERE c.id = ee.contact_id AND c.email ILIKE '%' || $${paramCount} || '%'
      )`);
      params.push(contact_email);
    }

    // Date range filters
    if (date_from) {
      paramCount++;
      conditions.push(`ee.occurred_at >= $${paramCount}`);
      params.push(date_from);
    } else {
      // Default to days parameter if no date_from
      paramCount++;
      conditions.push(`ee.occurred_at >= NOW() - INTERVAL '1 day' * $${paramCount}`);
      params.push(parseInt(days));
    }

    if (date_to) {
      paramCount++;
      conditions.push(`ee.occurred_at <= $${paramCount}`);
      params.push(date_to);
    }

    const whereClause = conditions.join(' AND ');

    const statsQuery = `
      SELECT 
        type,
        COUNT(*) as count
      FROM email_events ee
      WHERE ${whereClause}
      GROUP BY type
      ORDER BY count DESC
    `;

    const result = await query(statsQuery, params);

    const stats = {
      total: result.rows.reduce((sum, row) => sum + parseInt(row.count), 0),
      by_type: result.rows.reduce((acc, row) => {
        acc[row.type] = parseInt(row.count);
        return acc;
      }, {})
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error({ error, tenantId: req.tenantId }, 'Failed to fetch tracking stats');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve tracking statistics' 
    });
  }
});
router.get('/stats', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const tenantId = req.tenantId;

    const statsQuery = `
      SELECT 
        type,
        COUNT(*) as count
      FROM email_events
      WHERE tenant_id = $1 
        AND occurred_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY type
      ORDER BY count DESC
    `;

    const result = await query(statsQuery, [tenantId]);

    const stats = {
      total: result.rows.reduce((sum, row) => sum + parseInt(row.count), 0),
      by_type: result.rows.reduce((acc, row) => {
        acc[row.type] = parseInt(row.count);
        return acc;
      }, {})
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error({ error, tenantId: req.tenantId }, 'Failed to fetch tracking stats');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve tracking statistics' 
    });
  }
});

// ==========================================
// PUBLIC TRACKING ROUTES (no auth required)
// ==========================================

/**
 * Click tracking redirect - /c/:token
 * Redirects user to the original URL and records click event
 */
router.get('/c/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { url: fallbackUrl } = req.query;
    
    const decoded = verifyToken(token);
    
    if (!decoded || decoded.type !== 'click') {
      logger.warn({ token: token.substring(0, 20) + '...' }, 'Invalid click token');
      // Try fallback URL from query param
      if (fallbackUrl) {
        return res.redirect(decodeURIComponent(fallbackUrl));
      }
      return res.status(400).send('Invalid or expired tracking link');
    }
    
    const { tid: tenantId, cid: campaignId, uid: contactId, url: originalUrl, idx: linkIndex } = decoded;
    
    // Record click event
    try {
      await query(
        `INSERT INTO email_events (tenant_id, campaign_id, contact_id, type, payload)
         VALUES ($1, $2, $3, 'clicked', $4)`,
        [tenantId, campaignId, contactId, JSON.stringify({ url: originalUrl, linkIndex, clickedAt: new Date().toISOString() })]
      );
      logger.info({ campaignId, contactId, linkIndex }, 'Click event recorded');
    } catch (dbError) {
      // Don't block redirect if DB insert fails
      logger.error({ error: dbError.message, campaignId }, 'Failed to record click event');
    }
    
    // Redirect to original URL
    const redirectUrl = originalUrl || fallbackUrl;
    if (redirectUrl) {
      return res.redirect(decodeURIComponent(redirectUrl));
    }
    
    return res.status(400).send('No redirect URL available');
  } catch (error) {
    logger.error({ error: error.message }, 'Click tracking error');
    const { url: fallbackUrl } = req.query;
    if (fallbackUrl) {
      return res.redirect(decodeURIComponent(fallbackUrl));
    }
    return res.status(500).send('Tracking error');
  }
});

/**
 * Unsubscribe handler - /t/u/:token
 * Processes unsubscribe request and shows confirmation
 */
router.get('/t/u/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const decoded = verifyToken(token);
    
    if (!decoded || decoded.type !== 'unsubscribe') {
      logger.warn({ token: token.substring(0, 20) + '...' }, 'Invalid unsubscribe token');
      return res.status(400).send(`
        <!DOCTYPE html>
        <html><head><title>Invalid Link</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>Invalid or Expired Link</h1>
          <p>This unsubscribe link is no longer valid.</p>
        </body></html>
      `);
    }
    
    const { tid: tenantId, cid: campaignId, uid: contactId } = decoded;
    
    // Get contact email
    const contactResult = await query(
      'SELECT email FROM contacts WHERE id = $1 AND tenant_id = $2',
      [contactId, tenantId]
    );
    
    if (contactResult.rowCount === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html><head><title>Not Found</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>Contact Not Found</h1>
          <p>We couldn't find your subscription information.</p>
        </body></html>
      `);
    }
    
    const email = contactResult.rows[0].email;
    
    // Get tenant's motorical_account_id for suppressions
    const tenantResult = await query(
      'SELECT motorical_account_id FROM tenants WHERE id = $1',
      [tenantId]
    );
    
    const motoricalAccountId = tenantResult.rows[0]?.motorical_account_id;
    
    // Add to suppressions list (prevents future sends)
    if (motoricalAccountId) {
      await query(
        `INSERT INTO suppressions (motorical_account_id, tenant_id, email, reason, source)
         VALUES ($1, $2, $3, 'unsubscribed', 'user_request')
         ON CONFLICT (motorical_account_id, email) DO UPDATE SET
           reason = 'unsubscribed'`,
        [motoricalAccountId, tenantId, email]
      );
    }
    
    // Update contact status
    await query(
      `UPDATE contacts SET status = 'unsubscribed' WHERE id = $1 AND tenant_id = $2`,
      [contactId, tenantId]
    );
    
    // Record in unsubscribe_events table
    try {
      await query(
        `INSERT INTO unsubscribe_events (tenant_id, campaign_id, email, source)
         VALUES ($1, $2, $3, 'link_click')`,
        [tenantId, campaignId, email]
      );
    } catch (e) {
      // Table might not exist, ignore
      console.log('unsubscribe_events insert skipped:', e.message);
    }
    
    logger.info({ tenantId, campaignId, contactId, email }, 'Unsubscribe processed');
    
    // Return success page
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Unsubscribed</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; margin: 0; padding: 0; }
          .container { max-width: 500px; margin: 80px auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #333; margin-bottom: 16px; }
          p { color: #666; line-height: 1.6; }
          .email { background: #f0f0f0; padding: 8px 16px; border-radius: 6px; display: inline-block; margin: 16px 0; font-family: monospace; }
          .checkmark { font-size: 48px; margin-bottom: 16px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="checkmark">✓</div>
          <h1>Successfully Unsubscribed</h1>
          <p>You have been removed from our mailing list.</p>
          <div class="email">${email}</div>
          <p>You will no longer receive marketing emails from us.</p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    logger.error({ error: error.message }, 'Unsubscribe error');
    return res.status(500).send(`
      <!DOCTYPE html>
      <html><head><title>Error</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>Something Went Wrong</h1>
        <p>We couldn't process your unsubscribe request. Please try again later.</p>
      </body></html>
    `);
  }
});

/**
 * One-click unsubscribe (RFC 8058) - POST /t/u/:token
 * Handles List-Unsubscribe-Post header
 */
router.post('/t/u/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const decoded = verifyToken(token);
    
    if (!decoded || decoded.type !== 'unsubscribe') {
      return res.status(400).json({ success: false, error: 'Invalid token' });
    }
    
    const { tid: tenantId, cid: campaignId, uid: contactId } = decoded;
    
    // Get contact email
    const contactResult = await query(
      'SELECT email FROM contacts WHERE id = $1 AND tenant_id = $2',
      [contactId, tenantId]
    );
    
    if (contactResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    
    const email = contactResult.rows[0].email;
    
    // Get tenant's motorical_account_id
    const tenantResult = await query(
      'SELECT motorical_account_id FROM tenants WHERE id = $1',
      [tenantId]
    );
    
    const motoricalAccountId = tenantResult.rows[0]?.motorical_account_id;
    
    // Add to suppressions
    if (motoricalAccountId) {
      await query(
        `INSERT INTO suppressions (motorical_account_id, email, reason, source)
         VALUES ($1, $2, 'unsubscribed', 'one_click')
         ON CONFLICT (motorical_account_id, email) DO UPDATE SET
           reason = 'unsubscribed',
           updated_at = NOW()`,
        [motoricalAccountId, email]
      );
    }
    
    // Update contact status
    await query(
      `UPDATE contacts SET status = 'unsubscribed' WHERE id = $1 AND tenant_id = $2`,
      [contactId, tenantId]
    );
    
    // Record event
    await query(
      `INSERT INTO email_events (tenant_id, campaign_id, contact_id, type, payload)
       VALUES ($1, $2, $3, 'unsubscribed', $4)`,
      [tenantId, campaignId, contactId, JSON.stringify({ email, unsubscribedAt: new Date().toISOString(), source: 'one_click' })]
    );
    
    logger.info({ tenantId, campaignId, contactId, email }, 'One-click unsubscribe processed');
    
    return res.status(200).json({ success: true, message: 'Unsubscribed' });
  } catch (error) {
    logger.error({ error: error.message }, 'One-click unsubscribe error');
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
});

export default router;
