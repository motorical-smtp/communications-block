import express from 'express';
import { query } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';
import pino from 'pino';

const router = express.Router();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

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

export default router;
