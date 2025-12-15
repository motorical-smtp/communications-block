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
      list_id,         // filter by list membership
      date_from,       // created after this date
      date_to,         // created before this date
      search,          // search name or email
      sort_by = 'created_at',  // column to sort by (or comma-separated for multi-sort)
      sort_order = 'desc',     // asc or desc (or comma-separated for multi-sort)
      limit = 50,      // pagination
      offset = 0
    } = req.query;

    // Parse comma-separated arrays from query params
    const parseArrayParam = (param) => {
      if (!param || param === '') return [];
      if (Array.isArray(param)) return param;
      if (typeof param === 'string' && param.includes(',')) {
        return param.split(',').map(v => v.trim()).filter(v => v);
      }
      return param;
    };

    // Convert comma-separated filter params to arrays
    const statusArray = parseArrayParam(status);
    const engagementArray = parseArrayParam(engagement);
    const campaignIdArray = parseArrayParam(campaign_id);
    const listIdArray = parseArrayParam(list_id);

    const tenantId = req.tenantId;
    
    // Define sortable columns with their corresponding SQL expressions
    const sortableColumns = {
      'email': 'rs.email',
      'name': 'rs.name', 
      'computed_status': 'rs.computed_status',
      'engagement_level': 'rs.engagement_level',
      'quality_index': 'rs.quality_index',
      'created_at': 'rs.created_at',
      'last_engagement_at': 'rs.last_engagement_at',
      'last_click_at': 'rs.last_click_at',
      'last_campaign_activity': 'rs.last_campaign_activity',
      'email_domain': 'SUBSTRING(rs.email FROM \'@(.*)$\')',
      'list_count': '(SELECT COUNT(*) FROM list_contacts lc WHERE lc.contact_id = rs.id AND lc.status = \'active\')'
    };

    // Build ORDER BY clause (support multiple columns)
    const buildOrderBy = () => {
      const sortColumns = sort_by.split(',').map(col => col.trim());
      const sortOrders = sort_order.split(',').map(order => order.trim());
      
      const orderClauses = sortColumns.map((col, index) => {
        const validColumn = sortableColumns[col] || sortableColumns['created_at'];
        const validOrder = ['asc', 'desc'].includes((sortOrders[index] || 'desc').toLowerCase()) 
          ? (sortOrders[index] || 'desc').toUpperCase() 
          : 'DESC';
        return `${validColumn} ${validOrder}`;
      });
      
      return orderClauses.join(', ');
    };
    
    const orderByClause = buildOrderBy();
    
    // Build WHERE conditions
    const conditions = ['rs.tenant_id = $1'];
    const params = [tenantId];
    let paramCount = 1;

    // Status filter
    if (statusArray && (Array.isArray(statusArray) ? statusArray.length > 0 : statusArray)) {
      paramCount++;
      if (Array.isArray(statusArray) && statusArray.length > 0) {
        conditions.push(`rs.computed_status = ANY($\${paramCount})`);
        params.push(statusArray);
      } else {
        conditions.push(`rs.computed_status = $\${paramCount}`);
        params.push(statusArray);
      }
    }

    // Engagement level filter
    if (engagementArray && (Array.isArray(engagementArray) ? engagementArray.length > 0 : engagementArray)) {
      paramCount++;
      if (Array.isArray(engagementArray) && engagementArray.length > 0) {
        conditions.push(`rs.engagement_level = ANY($\${paramCount})`);
        params.push(engagementArray);
      } else {
        conditions.push(`rs.engagement_level = $\${paramCount}`);
        params.push(engagementArray);
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
    if (campaignIdArray && (Array.isArray(campaignIdArray) ? campaignIdArray.length > 0 : campaignIdArray)) {
      paramCount++;
      if (Array.isArray(campaignIdArray) && campaignIdArray.length > 0) {
        conditions.push(`EXISTS (
          SELECT 1 FROM email_events ee 
          WHERE ee.contact_id = rs.id AND ee.campaign_id = ANY($${paramCount})
        )`);
        params.push(campaignIdArray);
      } else {
        conditions.push(`EXISTS (
          SELECT 1 FROM email_events ee 
          WHERE ee.contact_id = rs.id AND ee.campaign_id = $${paramCount}
        )`);
        params.push(campaignIdArray);
      }
    }

    // List membership filter
    if (listIdArray && (Array.isArray(listIdArray) ? listIdArray.length > 0 : listIdArray)) {
      paramCount++;
      if (Array.isArray(listIdArray) && listIdArray.length > 0) {
        conditions.push(`EXISTS (
          SELECT 1 FROM list_contacts lc 
          WHERE lc.contact_id = rs.id AND lc.list_id = ANY($${paramCount}) AND lc.status = 'active'
        )`);
        params.push(listIdArray);
      } else {
        conditions.push(`EXISTS (
          SELECT 1 FROM list_contacts lc 
          WHERE lc.contact_id = rs.id AND lc.list_id = $${paramCount} AND lc.status = 'active'
        )`);
        params.push(listIdArray);
      }
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
      ORDER BY ${orderByClause}
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
        },
        sorting: {
          sort_by: sort_by,
          sort_order: sort_order.toLowerCase(),
          available_columns: Object.keys(sortableColumns)
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

// GET /api/recipients/campaigns - Get campaigns with recipient counts for filtering
router.get('/recipients/campaigns', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    
    const campaignsQuery = `
      SELECT 
        c.id,
        c.name,
        c.status,
        c.created_at,
        COUNT(DISTINCT ee.contact_id) as recipient_count
      FROM campaigns c
      LEFT JOIN email_events ee ON ee.campaign_id = c.id AND ee.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
      GROUP BY c.id, c.name, c.status, c.created_at
      HAVING COUNT(DISTINCT ee.contact_id) > 0
      ORDER BY c.created_at DESC
    `;
    
    const campaigns = await query(campaignsQuery, [tenantId]);
    
    res.json({
      success: true,
      data: campaigns.rows
    });
  } catch (error) {
    logger.error({ error, tenantId: req.tenantId }, 'Failed to get campaigns for filtering');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve campaign filter options' 
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

    // Soft delete: set deleted_at timestamp for recycle bin
    const result = await query(
      `UPDATE contacts 
       SET deleted_at = NOW()
       WHERE id = ANY($1) AND tenant_id = $2 AND deleted_at IS NULL
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
       SET deleted_at = NULL
       WHERE id = ANY($1) AND tenant_id = $2 AND deleted_at IS NOT NULL
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

// GET /api/recipients/deleted - Get soft-deleted recipients
router.get('/recipients/deleted', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    
    const query_text = `
      SELECT 
        c.id,
        c.email,
        c.name,
        c.status as contact_status,
        c.quality_index,
        c.deleted_at,
        c.created_at,
        SPLIT_PART(c.email, '@', 2) as email_domain
      FROM contacts c
      WHERE c.tenant_id = $1 AND c.deleted_at IS NOT NULL
      ORDER BY c.deleted_at DESC
      LIMIT 100
    `;
    
    const result = await query(query_text, [tenantId]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error({ error, tenantId: req.tenantId }, 'Failed to get deleted recipients');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve deleted recipients' 
    });
  }
});

// PATCH /api/recipients/:id/restore - Restore a soft-deleted recipient
router.patch('/recipients/:id/restore', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const contactId = req.params.id;
    const tenantId = req.tenantId;
    
    // Ensure contact belongs to tenant and is soft-deleted
    const contact = await query(
      'SELECT id, email FROM contacts WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NOT NULL',
      [contactId, tenantId]
    );
    
    if (contact.rowCount === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Contact not found in recycle bin' 
      });
    }
    
    // Restore contact: clear deleted_at timestamp
    await query(
      'UPDATE contacts SET deleted_at = NULL WHERE id=$1 AND tenant_id=$2',
      [contactId, tenantId]
    );
    
    logger.info({ contactId, tenantId, email: contact.rows[0].email }, 'Contact restored from soft delete');
    res.json({ 
      success: true, 
      message: 'Contact restored successfully' 
    });
  } catch (error) {
    logger.error({ error, contactId: req.params.id, tenantId: req.tenantId }, 'Failed to restore contact');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to restore contact' 
    });
  }
});

// DELETE /api/recipients/:id/permanent - Permanently delete a soft-deleted recipient
router.delete('/recipients/:id/permanent', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const contactId = req.params.id;
    const tenantId = req.tenantId;
    
    // Ensure contact belongs to tenant and is soft-deleted
    const contact = await query(
      'SELECT id, email FROM contacts WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NOT NULL',
      [contactId, tenantId]
    );
    
    if (contact.rowCount === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Contact not found in recycle bin' 
      });
    }
    
    const email = contact.rows[0].email;
    
    // Hard delete: Remove from list associations first (CASCADE will handle)
    await query('DELETE FROM list_contacts WHERE contact_id=$1', [contactId]);
    
    // Remove any email events for this contact
    await query('DELETE FROM email_events WHERE contact_id=$1', [contactId]);
    
    // Finally delete the contact
    await query('DELETE FROM contacts WHERE id=$1 AND tenant_id=$2', [contactId, tenantId]);
    
    logger.info({ contactId, tenantId, email }, 'Contact permanently deleted');
    res.json({ 
      success: true, 
      message: 'Contact permanently deleted' 
    });
  } catch (error) {
    logger.error({ error, contactId: req.params.id, tenantId: req.tenantId }, 'Failed to permanently delete contact');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to permanently delete contact' 
    });
  }
});

// DELETE /api/recipients/cleanup - Bulk permanent delete of soft-deleted recipients
router.delete('/recipients/cleanup', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { olderThanDays = 30 } = req.body || {};
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    
    // Get contacts to be permanently deleted
    const contactsToDelete = await query(
      'SELECT id, email FROM contacts WHERE tenant_id=$1 AND deleted_at IS NOT NULL AND deleted_at < $2',
      [tenantId, cutoffDate.toISOString()]
    );
    
    if (contactsToDelete.rowCount === 0) {
      return res.json({ 
        success: true, 
        message: 'No contacts found for cleanup',
        deleted_count: 0 
      });
    }
    
    const contactIds = contactsToDelete.rows.map(c => c.id);
    const emails = contactsToDelete.rows.map(c => c.email);
    
    // Batch delete related data
    for (const contactId of contactIds) {
      await query('DELETE FROM list_contacts WHERE contact_id=$1', [contactId]);
      await query('DELETE FROM email_events WHERE contact_id=$1', [contactId]);
    }
    
    // Delete the contacts themselves
    await query(
      'DELETE FROM contacts WHERE tenant_id=$1 AND deleted_at IS NOT NULL AND deleted_at < $2',
      [tenantId, cutoffDate.toISOString()]
    );
    
    logger.info({ 
      tenantId, 
      deletedCount: contactsToDelete.rowCount,
      emails: emails.slice(0, 10), // Log first 10 emails
      olderThanDays 
    }, 'Bulk contact cleanup completed');
    
    res.json({ 
      success: true, 
      message: `Permanently deleted ${contactsToDelete.rowCount} contacts`,
      deleted_count: contactsToDelete.rowCount
    });
  } catch (error) {
    logger.error({ error, tenantId: req.tenantId }, 'Failed to cleanup contacts');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to cleanup contacts' 
    });
  }
});

export default router;
