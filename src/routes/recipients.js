import express from 'express';
import { query, pool } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';
import pino from 'pino';

const router = express.Router();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Helper to get tenant from header (consistent with other route files)
function requireTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
  req.tenantId = tenantId;
  next();
}

/**
 * Recipients API - Excel-like filtering and mega list management
 */

// GET /api/recipients - Filterable recipients with computed status
router.get('/recipients', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const {
      status,          // computed_status filter: new,sent,delivered,engaged,bounced,unsubscribed,complained
      engagement,      // engagement_level: none,low,medium,high
      suppressed,      // true/false - suppression status
      campaign_id,     // participated in specific campaign
      email_domain,    // filter by email domain
      date_from,       // created after this date
      date_to,         // created before this date
      search,          // search name or email
      limit = 50,      // pagination
      offset = 0
    } = req.query;

    const tenantId = req.tenantId;
    
    // Build WHERE conditions
    const conditions = ['rs.tenant_id = $1'];
    const params = [tenantId];
    let paramCount = 1;

    // Status filter
    if (status) {
      paramCount++;
      if (Array.isArray(status)) {
        conditions.push(`rs.computed_status = ANY($${paramCount})`);
        params.push(status);
      } else {
        conditions.push(`rs.computed_status = $${paramCount}`);
        params.push(status);
      }
    }

    // Engagement level filter
    if (engagement) {
      paramCount++;
      if (Array.isArray(engagement)) {
        conditions.push(`rs.engagement_level = ANY($${paramCount})`);
        params.push(engagement);
      } else {
        conditions.push(`rs.engagement_level = $${paramCount}`);
        params.push(engagement);
      }
    }

    // Suppression filter
    if (suppressed !== undefined) {
      if (suppressed === 'true') {
        conditions.push('rs.suppression_reason IS NOT NULL');
      } else if (suppressed === 'false') {
        conditions.push('rs.suppression_reason IS NULL');
      }
    }

    // Campaign participation filter
    if (campaign_id) {
      paramCount++;
      conditions.push(`EXISTS (
        SELECT 1 FROM email_events ee 
        WHERE ee.contact_id = rs.id AND ee.campaign_id = $${paramCount}
      )`);
      params.push(campaign_id);
    }

    // Email domain filter
    if (email_domain) {
      paramCount++;
      conditions.push(`rs.email LIKE '%@' || $${paramCount}`);
      params.push(email_domain);
    }

    // Date range filters
    if (date_from) {
      paramCount++;
      conditions.push(`rs.created_at >= $${paramCount}`);
      params.push(date_from);
    }

    if (date_to) {
      paramCount++;
      conditions.push(`rs.created_at <= $${paramCount}`);
      params.push(date_to);
    }

    // Search filter
    if (search) {
      paramCount++;
      conditions.push(`(rs.email ILIKE '%' || $${paramCount} || '%' OR rs.name ILIKE '%' || $${paramCount} || '%')`);
      params.push(search);
    }

    // Add pagination params
    paramCount++;
    const limitParam = paramCount;
    params.push(parseInt(limit));
    
    paramCount++;
    const offsetParam = paramCount;
    params.push(parseInt(offset));

    // Build the query
    const whereClause = conditions.join(' AND ');
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM recipient_status rs
      WHERE ${whereClause}
    `;
    
    const countResult = await query(countQuery, params.slice(0, -2)); // exclude limit/offset for count
    const total = parseInt(countResult.rows[0].total);

    // Get paginated results
    const dataQuery = `
      SELECT 
        rs.id,
        rs.email,
        rs.name,
        rs.computed_status,
        rs.engagement_level,
        rs.quality_index,
        rs.created_at,
        rs.last_engagement_at,
        rs.last_click_at,
        rs.suppression_reason,
        rs.suppressed_at,
        rs.last_campaign_id,
        rs.last_campaign_activity,
        -- Email domain extraction
        SUBSTRING(rs.email FROM '@(.*)$') as email_domain,
        -- List memberships count
        (SELECT COUNT(*) FROM list_contacts lc WHERE lc.contact_id = rs.id AND lc.status = 'active') as list_count
      FROM recipient_status rs
      WHERE ${whereClause}
      ORDER BY rs.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const result = await query(dataQuery, params);

    res.json({
      success: true,
      data: {
        recipients: result.rows,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: (parseInt(offset) + parseInt(limit)) < total
        },
        filters_applied: {
          status, engagement, suppressed, campaign_id, email_domain, 
          date_from, date_to, search
        }
      }
    });

  } catch (error) {
    logger.error({ tenantId: req.tenantId, error: error.message }, 'Failed to fetch recipients');
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recipients',
      details: error.message
    });
  }
});

// POST /api/recipients/filter - Preview filter results (no save)
router.post('/recipients/filter', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { filters } = req.body;
    const tenantId = req.tenantId;

    // Convert the filters object to query parameters format
    const filterParams = {
      ...filters,
      limit: 10, // Preview only first 10
      offset: 0
    };

    // Reuse the GET logic by creating a mock request
    const mockReq = {
      tenantId,
      query: filterParams
    };

    // Build the same query logic
    const conditions = ['rs.tenant_id = $1'];
    const params = [tenantId];
    let paramCount = 1;

    // Apply filters (simplified version)
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        paramCount++;
        switch (key) {
          case 'status':
            conditions.push(`rs.computed_status = ANY($${paramCount})`);
            params.push(Array.isArray(value) ? value : [value]);
            break;
          case 'engagement':
            conditions.push(`rs.engagement_level = ANY($${paramCount})`);
            params.push(Array.isArray(value) ? value : [value]);
            break;
          case 'suppressed':
            if (value === true) {
              conditions.push('rs.suppression_reason IS NOT NULL');
              paramCount--; // No param used
            } else if (value === false) {
              conditions.push('rs.suppression_reason IS NULL');
              paramCount--; // No param used
            }
            break;
          case 'email_domain':
            conditions.push(`rs.email LIKE '%@' || $${paramCount}`);
            params.push(value);
            break;
          case 'search':
            conditions.push(`(rs.email ILIKE '%' || $${paramCount} || '%' OR rs.name ILIKE '%' || $${paramCount} || '%')`);
            params.push(value);
            break;
        }
      }
    });

    const whereClause = conditions.join(' AND ');
    
    // Get count and preview
    const countQuery = `SELECT COUNT(*) as total FROM recipient_status rs WHERE ${whereClause}`;
    const countResult = await query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    const previewQuery = `
      SELECT rs.id, rs.email, rs.name, rs.computed_status, rs.engagement_level
      FROM recipient_status rs
      WHERE ${whereClause}
      ORDER BY rs.created_at DESC
      LIMIT 10
    `;

    const previewResult = await query(previewQuery, params);

    res.json({
      success: true,
      data: {
        total_matches: total,
        preview: previewResult.rows,
        filters_applied: filters
      }
    });

  } catch (error) {
    logger.error({ tenantId: req.tenantId, error: error.message }, 'Failed to preview filter');
    res.status(500).json({
      success: false,
      error: 'Failed to preview filter',
      details: error.message
    });
  }
});

// POST /api/recipients/export - Export filtered recipients as CSV
router.post('/recipients/export', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { filters } = req.body;
    const tenantId = req.tenantId;

    // Build query similar to filter preview but get all results
    const conditions = ['rs.tenant_id = $1'];
    const params = [tenantId];
    let paramCount = 1;

    // Apply filters (same logic as filter preview)
    Object.entries(filters || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        paramCount++;
        switch (key) {
          case 'status':
            conditions.push(`rs.computed_status = ANY($${paramCount})`);
            params.push(Array.isArray(value) ? value : [value]);
            break;
          case 'engagement':
            conditions.push(`rs.engagement_level = ANY($${paramCount})`);
            params.push(Array.isArray(value) ? value : [value]);
            break;
          case 'email_domain':
            conditions.push(`rs.email LIKE '%@' || $${paramCount}`);
            params.push(value);
            break;
        }
      }
    });

    const whereClause = conditions.join(' AND ');
    
    const exportQuery = `
      SELECT 
        rs.email,
        rs.name,
        rs.computed_status,
        rs.engagement_level,
        rs.quality_index,
        rs.created_at::date as date_added,
        rs.last_engagement_at::date as last_engagement,
        COALESCE(rs.suppression_reason, 'active') as status
      FROM recipient_status rs
      WHERE ${whereClause}
      ORDER BY rs.created_at DESC
      LIMIT 10000  -- Reasonable export limit
    `;

    const result = await query(exportQuery, params);
    
    // Generate CSV content
    const headers = ['Email', 'Name', 'Status', 'Engagement', 'Quality', 'Date Added', 'Last Engagement', 'Suppression'];
    const csvRows = [headers.join(',')];
    
    result.rows.forEach(row => {
      const csvRow = [
        `"${row.email}"`,
        `"${row.name || ''}"`,
        `"${row.computed_status}"`,
        `"${row.engagement_level}"`,
        row.quality_index,
        row.date_added,
        row.last_engagement || '',
        `"${row.status}"`
      ];
      csvRows.push(csvRow.join(','));
    });

    const csvContent = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="recipients-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csvContent);

  } catch (error) {
    logger.error({ tenantId: req.tenantId, error: error.message }, 'Failed to export recipients');
    res.status(500).json({
      success: false,
      error: 'Failed to export recipients',
      details: error.message
    });
  }
});

// POST /api/recipients/bulk-delete - Bulk delete recipients (soft delete with recycle bin)
router.post('/recipients/bulk-delete', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { recipient_ids, reason = 'bulk_delete' } = req.body;
    const tenantId = req.tenantId;

    if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'recipient_ids array is required'
      });
    }

    // Soft delete: update contact status instead of hard delete
    const result = await query(
      `UPDATE contacts 
       SET status = 'deleted', 
           updated_at = NOW()
       WHERE id = ANY($1) AND tenant_id = $2 AND status != 'deleted'
       RETURNING id, email, name`,
      [recipient_ids, tenantId]
    );

    logger.info({
      tenantId,
      deletedCount: result.rowCount,
      reason
    }, 'Bulk delete recipients completed');

    res.json({
      success: true,
      data: {
        deleted_count: result.rowCount,
        deleted_recipients: result.rows,
        reason
      }
    });

  } catch (error) {
    logger.error({ tenantId: req.tenantId, error: error.message }, 'Failed to bulk delete recipients');
    res.status(500).json({
      success: false,
      error: 'Failed to bulk delete recipients',
      details: error.message
    });
  }
});

// POST /api/recipients/bulk-move - Move recipients between lists
router.post('/recipients/bulk-move', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { recipient_ids, from_list_id, to_list_id } = req.body;
    const tenantId = req.tenantId;

    if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'recipient_ids array is required'
      });
    }

    if (!to_list_id) {
      return res.status(400).json({
        success: false,
        error: 'to_list_id is required'
      });
    }

    // Verify target list exists and belongs to tenant
    const listCheck = await query(
      'SELECT id FROM lists WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
      [to_list_id, tenantId]
    );

    if (listCheck.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Target list not found'
      });
    }

    const client = await pool.connect();
    let moved_count = 0;

    try {
      await client.query('BEGIN');

      // Remove from source list if specified
      if (from_list_id) {
        await client.query(
          'DELETE FROM list_contacts WHERE list_id = $1 AND contact_id = ANY($2)',
          [from_list_id, recipient_ids]
        );
      }

      // Add to target list (with conflict handling)
      for (const contactId of recipient_ids) {
        const result = await client.query(
          'INSERT INTO list_contacts (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING contact_id',
          [to_list_id, contactId]
        );
        if (result.rowCount > 0) moved_count++;
      }

      await client.query('COMMIT');

      logger.info({
        tenantId,
        movedCount: moved_count,
        fromListId: from_list_id,
        toListId: to_list_id
      }, 'Bulk move recipients completed');

      res.json({
        success: true,
        data: {
          moved_count,
          from_list_id,
          to_list_id
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    logger.error({ tenantId: req.tenantId, error: error.message }, 'Failed to bulk move recipients');
    res.status(500).json({
      success: false,
      error: 'Failed to bulk move recipients',
      details: error.message
    });
  }
});

// GET /api/recipients/deleted - View soft-deleted recipients (recycle bin)
router.get('/recipients/deleted', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const tenantId = req.tenantId;

    const result = await query(
      `SELECT id, email, name, updated_at as deleted_at, quality_index
       FROM contacts 
       WHERE tenant_id = $1 AND status = 'deleted'
       ORDER BY updated_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset]
    );

    const countResult = await query(
      'SELECT COUNT(*) as total FROM contacts WHERE tenant_id = $1 AND status = \'deleted\'',
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        recipients: result.rows,
        pagination: {
          total: parseInt(countResult.rows[0].total),
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: parseInt(countResult.rows[0].total) > parseInt(offset) + parseInt(limit)
        }
      }
    });

  } catch (error) {
    logger.error({ tenantId: req.tenantId, error: error.message }, 'Failed to get deleted recipients');
    res.status(500).json({
      success: false,
      error: 'Failed to get deleted recipients',
      details: error.message
    });
  }
});

// POST /api/recipients/restore - Restore recipients from recycle bin
router.post('/recipients/restore', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { recipient_ids } = req.body;
    const tenantId = req.tenantId;

    if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'recipient_ids array is required'
      });
    }

    const result = await query(
      `UPDATE contacts 
       SET status = 'active', updated_at = NOW()
       WHERE id = ANY($1) AND tenant_id = $2 AND status = 'deleted'
       RETURNING id, email, name`,
      [recipient_ids, tenantId]
    );

    logger.info({
      tenantId,
      restoredCount: result.rowCount
    }, 'Restore recipients completed');

    res.json({
      success: true,
      data: {
        restored_count: result.rowCount,
        restored_recipients: result.rows
      }
    });

  } catch (error) {
    logger.error({ tenantId: req.tenantId, error: error.message }, 'Failed to restore recipients');
    res.status(500).json({
      success: false,
      error: 'Failed to restore recipients',
      details: error.message
    });
  }
});

export default router;
