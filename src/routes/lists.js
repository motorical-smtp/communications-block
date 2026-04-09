import express from 'express';
import { query } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';
import { csvUploadRateLimiter } from '../middleware/csvRateLimiter.js';
import { validateCsvData } from '../utils/csvInjectionValidator.js';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const router = express.Router();

// Helper to get tenant from header for now (later JWT derive)
function requireTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
  req.tenantId = tenantId;
  next();
}

router.post('/lists', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { name, description, type = 'user' } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const r = await query(
      'INSERT INTO lists (tenant_id, name, description, type) VALUES ($1,$2,$3,$4) RETURNING id, name, description, type, created_at',
      [req.tenantId, name, description || null, type]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to create list' });
  }
});

// POST /api/lists/from-filter - Save filtered recipients as a new list
router.post('/lists/from-filter', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { name, description, filters } = req.body;
    const tenantId = req.tenantId;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'List name is required' });
    }

    // Create the list first
    const listResult = await query(
      'INSERT INTO lists (tenant_id, name, description, type, filter_definition) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, description, type, created_at',
      [tenantId, name, description || `Filtered list: ${name}`, 'smart', JSON.stringify(filters || {})]
    );
    
    const listId = listResult.rows[0].id;

    // Apply the same filter logic as in recipients.js to get matching contacts
    const conditions = ['rs.tenant_id = $1'];
    const params = [tenantId];
    let paramCount = 1;

    // Apply filters to find matching recipients
    if (filters) {
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
    }

    const whereClause = conditions.join(' AND ');
    
    // Get matching recipients and add them to the list
    const recipientsQuery = `
      SELECT rs.id
      FROM recipient_status rs
      WHERE ${whereClause}
      LIMIT 10000  -- Reasonable limit for list creation
    `;

    const recipientsResult = await query(recipientsQuery, params);
    
    // Add recipients to the list
    if (recipientsResult.rows.length > 0) {
      const insertValues = recipientsResult.rows.map((_, index) => 
        `($1, $${index + 2}, 'active', NOW())`
      ).join(', ');
      
      const insertQuery = `
        INSERT INTO list_contacts (list_id, contact_id, status, created_at) 
        VALUES ${insertValues}
        ON CONFLICT (list_id, contact_id) DO NOTHING
      `;
      
      const insertParams = [listId, ...recipientsResult.rows.map(r => r.id)];
      await query(insertQuery, insertParams);
    }

    // Get final count
    const countResult = await query(
      'SELECT COUNT(*) as count FROM list_contacts WHERE list_id = $1 AND status = $2',
      [listId, 'active']
    );

    res.json({
      success: true,
      data: {
        ...listResult.rows[0],
        recipient_count: parseInt(countResult.rows[0].count),
        filters_applied: filters
      }
    });

  } catch (error) {
    console.error('Failed to create list from filter:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create list from filter',
      details: error.message
    });
  }
});

router.get('/lists', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const r = await query(`SELECT l.id, l.name, l.description, l.type, l.filter_definition, l.created_at,
      COALESCE(lc.cnt, 0)::int AS contact_count
      FROM lists l
      LEFT JOIN (SELECT list_id, COUNT(*) AS cnt FROM list_contacts GROUP BY list_id) lc ON lc.list_id = l.id
      WHERE l.tenant_id=$1 AND l.deleted_at IS NULL
      ORDER BY l.type DESC, l.created_at DESC`, [req.tenantId]);
    res.json({ success: true, data: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to fetch lists' });
  }
});

router.get('/lists/:id/contacts', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const listId = req.params.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(req.query.pageSize, 10) || 50));
    const q = (req.query.q || '').toString().trim();

    const whereClauses = ['lc.list_id = $1'];
    const params = [listId];
    if (q) {
      params.push(`%${q}%`);
      whereClauses.push('(c.email ILIKE $' + params.length + ' OR c.name ILIKE $' + params.length + ' OR c.identity_name ILIKE $' + params.length + ')');
    }

    const whereSql = whereClauses.join(' AND ');

    // Total count
    const countSql = `SELECT COUNT(*)::int AS count
                      FROM list_contacts lc
                      JOIN contacts c ON c.id = lc.contact_id
                      WHERE ${whereSql}`;
    const countRes = await query(countSql, params);
    const total = countRes.rows?.[0]?.count || 0;

    // Page data
    const offset = (page - 1) * pageSize;
    const dataSql = `SELECT c.id, c.email, c.name, c.phone, c.identity_type, c.identity_name, c.status, c.quality_index
                     FROM list_contacts lc
                     JOIN contacts c ON c.id = lc.contact_id
                     WHERE ${whereSql}
                     ORDER BY c.created_at DESC NULLS LAST, c.email ASC
                     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const dataParams = params.concat([pageSize, offset]);
    const dataRes = await query(dataSql, dataParams);

    res.json({ success: true, data: { items: dataRes.rows, total } });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to fetch list contacts' });
  }
});

// Delete a single list (and detach contacts via cascade)
router.delete('/lists/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    // Ensure list belongs to tenant
    const chk = await query('SELECT id FROM lists WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (chk.rowCount === 0) return res.status(404).json({ success: false, error: 'List not found' });
    await query('DELETE FROM lists WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'List deleted' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to delete list' });
  }
});

// Bulk delete lists: body { ids: [uuid...] }
router.delete('/lists', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ success: false, error: 'ids[] required' });
    // Delete only lists that belong to tenant
    await query('DELETE FROM lists WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [req.tenantId, ids]);
    res.json({ success: true, message: 'Lists deleted' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to bulk delete lists' });
  }
});
router.post('/contacts/upsert', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { email, name, phone, identity_type, identity_name } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: 'email required' });
    const r = await query(
      `INSERT INTO contacts (tenant_id, email, name, phone, identity_type, identity_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, email) DO UPDATE SET
         name=COALESCE(EXCLUDED.name, contacts.name),
         phone=COALESCE(EXCLUDED.phone, contacts.phone),
         identity_type=COALESCE(EXCLUDED.identity_type, contacts.identity_type),
         identity_name=COALESCE(EXCLUDED.identity_name, contacts.identity_name),
         updated_at=NOW()
       RETURNING id, email, name, phone, identity_type, identity_name`,
      [req.tenantId, email, name || null, phone || null, identity_type || null, identity_name || null]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to upsert contact' });
  }
});

router.post('/lists/:id/contacts', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { emails, contact_ids } = req.body || {};
    const listId = req.params.id;
    const tenantId = req.tenantId;
    
    // Verify list belongs to tenant
    const listCheck = await query('SELECT id FROM lists WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [listId, tenantId]);
    if (listCheck.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'List not found' });
    }
    
    const added = [];
    
    // Support adding by contact IDs (from MegaList selections)
    if (Array.isArray(contact_ids) && contact_ids.length > 0) {
      // Verify all contacts belong to tenant and add them to list
      const validContactsResult = await query(
        'SELECT id FROM contacts WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND deleted_at IS NULL',
        [contact_ids, tenantId]
      );
      
      const validIds = validContactsResult.rows.map(r => r.id);
      
      if (validIds.length > 0) {
        // Batch insert into list_contacts
        const insertValues = validIds.map((_, index) => 
          `($1, $${index + 2}, 'active', NOW())`
        ).join(', ');
        
        const insertQuery = `
          INSERT INTO list_contacts (list_id, contact_id, status, created_at) 
          VALUES ${insertValues}
          ON CONFLICT (list_id, contact_id) DO NOTHING
          RETURNING contact_id
        `;
        
        const insertParams = [listId, ...validIds];
        const insertResult = await query(insertQuery, insertParams);
        
        added.push(...insertResult.rows.map(r => ({ id: r.contact_id })));
      }
      
      return res.json({ 
        success: true, 
        data: { 
          addedCount: added.length,
          requestedCount: contact_ids.length,
          validCount: validIds.length
        } 
      });
    }
    
    // Original logic for adding by emails
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ success: false, error: 'emails[] or contact_ids[] required' });
    }

    for (const e of emails) {
      const emailData = typeof e === 'string' ? { email: e } : e;
      const { email, name, phone, identity_type, identity_name } = emailData;
      if (!email) continue;
      const cr = await query(
        `INSERT INTO contacts (tenant_id, email, name, phone, identity_type, identity_name)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, email) DO UPDATE SET
           name=COALESCE(EXCLUDED.name, contacts.name),
           phone=COALESCE(EXCLUDED.phone, contacts.phone),
           identity_type=COALESCE(EXCLUDED.identity_type, contacts.identity_type),
           identity_name=COALESCE(EXCLUDED.identity_name, contacts.identity_name),
           updated_at=NOW()
         RETURNING id, email`,
        [tenantId, email, name || null, phone || null, identity_type || null, identity_name || null]
      );
      const contactId = cr.rows[0].id;
      await query(
        `INSERT INTO list_contacts (list_id, contact_id)
         VALUES ($1, $2) ON CONFLICT (list_id, contact_id) DO NOTHING`,
        [listId, contactId]
      );
      added.push({ id: contactId, email: cr.rows[0].email });
    }

    res.json({ success: true, data: { addedCount: added.length } });
  } catch (e) {
    logger.error({ err: e }, 'Failed to add contacts to list');
    res.status(500).json({ success: false, error: 'Failed to add contacts to list' });
  }
});

// Manual unsubscribe for a contact (customer-scoped)
router.post('/contacts/:id/unsubscribe', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const contactId = req.params.id;
    // Ensure contact belongs to tenant and get motorical_account_id
    const cr = await query(
      `SELECT c.email, t.motorical_account_id 
       FROM contacts c 
       JOIN tenants t ON t.id = c.tenant_id 
       WHERE c.id=$1 AND c.tenant_id=$2`, 
      [contactId, req.tenantId]
    );
    if (cr.rowCount === 0) return res.status(404).json({ success: false, error: 'Contact not found' });
    const { email, motorical_account_id } = cr.rows[0];
    
    // Insert customer-scoped suppression and update contact
    await query(
      `INSERT INTO suppressions (motorical_account_id, tenant_id, email, reason, source, landing_variant)
       VALUES ($1,$2,$3,'unsubscribe','manual','customer')
       ON CONFLICT (motorical_account_id, email) DO NOTHING`,
      [motorical_account_id, req.tenantId, email]
    );
    await query(`UPDATE contacts SET status='unsubscribed', updated_at=NOW() WHERE id=$1 AND tenant_id=$2`, [contactId, req.tenantId]);
    res.json({ success: true, message: 'Contact unsubscribed' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to unsubscribe contact' });
  }
});

// Manual resubscribe for a contact (customer-scoped)
router.put('/contacts/:id/resubscribe', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const contactId = req.params.id;
    // Ensure contact belongs to tenant and get motorical_account_id
    const cr = await query(
      `SELECT c.email, t.motorical_account_id 
       FROM contacts c 
       JOIN tenants t ON t.id = c.tenant_id 
       WHERE c.id=$1 AND c.tenant_id=$2`, 
      [contactId, req.tenantId]
    );
    if (cr.rowCount === 0) return res.status(404).json({ success: false, error: 'Contact not found' });
    const { email, motorical_account_id } = cr.rows[0];
    
    // Remove customer-scoped suppression and reactivate contact
    await query(
      `DELETE FROM suppressions 
       WHERE motorical_account_id=$1 AND email=$2`,
      [motorical_account_id, email]
    );
    await query(`UPDATE contacts SET status='active', updated_at=NOW() WHERE id=$1 AND tenant_id=$2`, [contactId, req.tenantId]);
    
    // Log resubscribe event
    await query(
      `INSERT INTO email_events (tenant_id, contact_id, type, payload)
       VALUES ($1,$2,'resubscribed', $3)`,
      [req.tenantId, contactId, JSON.stringify({ reason: 'manual_resubscribe', source: 'admin' })]
    );
    
    res.json({ success: true, message: 'Contact resubscribed successfully' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to resubscribe contact' });
  }
});

export default router;

// CSV Import — emails with optional fields: email,name,phone,identity_type,identity_name
// File size limit: 10MB (increased from 5MB)
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Audit logging helper
 */
async function logAuditEvent(tenantId, eventType, action, resourceType, resourceId, userIdentifier, details) {
  try {
    await query(
      `INSERT INTO audit_logs (tenant_id, event_type, action, resource_type, resource_id, user_identifier, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, eventType, action, resourceType, resourceId, userIdentifier, JSON.stringify(details)]
    );
  } catch (err) {
    logger.error({ err, tenantId, eventType }, 'Failed to write audit log');
  }
}

router.post('/lists/:id/contacts/import', 
  requireTenant, 
  requireEntitledTenant, 
  csvUploadRateLimiter, 
  upload.single('file'), 
  async (req, res) => {
    const listId = req.params.id;
    const tenantId = req.tenantId;
    const userIdentifier = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const dryRun = String(req.query.dryRun || req.body?.dryRun || 'false').toLowerCase() === 'true';
    
    try {
      // File validation
      if (!req.file || !req.file.buffer) {
        await logAuditEvent(
          tenantId,
          'csv_upload',
          'blocked',
          'list',
          listId,
          userIdentifier,
          { reason: 'no_file_provided' }
        );
        return res.status(400).json({ 
          success: false, 
          error: 'CSV file required (multipart form field "file")' 
        });
      }

      const fileSize = req.file.buffer.length;
      const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

      // Verify list belongs to tenant (authorization check)
      const listCheck = await query(
        'SELECT id FROM lists WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL',
        [listId, tenantId]
      );
      if (listCheck.rowCount === 0) {
        await logAuditEvent(
          tenantId,
          'csv_upload',
          'blocked',
          'list',
          listId,
          userIdentifier,
          { reason: 'unauthorized_list_access' }
        );
        return res.status(403).json({ 
          success: false, 
          error: 'List not found or access denied' 
        });
      }

      // Parse CSV
      const csvText = req.file.buffer.toString('utf8');
      let rows;
      try {
        rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
      } catch (parseError) {
        await logAuditEvent(
          tenantId,
          'csv_upload',
          'blocked',
          'list',
          listId,
          userIdentifier,
          { 
            reason: 'csv_parse_error',
            error: parseError.message,
            fileSize
          }
        );
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid CSV format',
          details: parseError.message
        });
      }

      // Server-side CSV injection validation
      const validation = validateCsvData(rows, 10);
      if (!validation.safe) {
        await logAuditEvent(
          tenantId,
          'csv_upload',
          'blocked',
          'list',
          listId,
          userIdentifier,
          { 
            reason: 'csv_injection_detected',
            violationCount: validation.violationCount,
            violations: validation.violations,
            fileSize,
            rowCount: validation.totalRows
          }
        );
        return res.status(400).json({
          success: false,
          error: 'CSV injection detected',
          message: `Found ${validation.violationCount} potential security threat(s) in CSV data. Please review and remove dangerous formulas or commands.`,
          violations: validation.violations,
          violationCount: validation.violationCount
        });
      }

      // Process rows - validate first, then batch insert
      let processed = 0; 
      let added = 0; 
      let upserts = 0; 
      let errors = 0;
      const errorSamples = [];
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      // Phase 1: Validate all rows
      const validRows = [];
      for (const row of rows) {
        processed += 1;
        const email = String(row.email || '').trim().toLowerCase();
        if (!email) { 
          errors += 1; 
          if (errorSamples.length < 3) errorSamples.push({ row, error: 'missing email' }); 
          continue; 
        }
        if (!emailRegex.test(email)) {
          errors += 1;
          if (errorSamples.length < 3) errorSamples.push({ row, error: 'invalid email format' });
          continue;
        }
        validRows.push({
          email,
          name: row.name || null,
          phone: row.phone || null,
          identity_type: row.identity_type || null,
          identity_name: row.identity_name || null,
        });
      }

      // Phase 2: Batch insert (skip if dryRun)
      if (!dryRun && validRows.length > 0) {
        const BATCH_SIZE = 200;
        for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
          const batch = validRows.slice(i, i + BATCH_SIZE);
          try {
            // Build multi-value INSERT for contacts
            const contactPlaceholders = [];
            const contactParams = [];
            let pIdx = 1;
            for (const r of batch) {
              contactPlaceholders.push(`($${pIdx},$${pIdx+1},$${pIdx+2},$${pIdx+3},$${pIdx+4},$${pIdx+5})`);
              contactParams.push(tenantId, r.email, r.name, r.phone, r.identity_type, r.identity_name);
              pIdx += 6;
            }
            const contactResult = await query(
              `INSERT INTO contacts (tenant_id, email, name, phone, identity_type, identity_name)
               VALUES ${contactPlaceholders.join(',')}
               ON CONFLICT (tenant_id, email) DO UPDATE SET
                 name=COALESCE(EXCLUDED.name, contacts.name),
                 phone=COALESCE(EXCLUDED.phone, contacts.phone),
                 identity_type=COALESCE(EXCLUDED.identity_type, contacts.identity_type),
                 identity_name=COALESCE(EXCLUDED.identity_name, contacts.identity_name),
                 updated_at=NOW()
               RETURNING id`,
              contactParams
            );

            // Build multi-value INSERT for list_contacts
            const listPlaceholders = [];
            const listParams = [];
            let lpIdx = 1;
            for (const cr of contactResult.rows) {
              listPlaceholders.push(`($${lpIdx},$${lpIdx+1})`);
              listParams.push(listId, cr.id);
              lpIdx += 2;
            }
            const listResult = await query(
              `INSERT INTO list_contacts (list_id, contact_id)
               VALUES ${listPlaceholders.join(',')}
               ON CONFLICT (list_id, contact_id) DO NOTHING`,
              listParams
            );

            added += listResult.rowCount;
            upserts += batch.length - listResult.rowCount;
          } catch (batchErr) {
            // Fallback: process batch rows individually
            logger.warn({ err: batchErr, batchStart: i, batchSize: batch.length }, 'Batch insert failed, falling back to individual inserts');
            for (const r of batch) {
              try {
                const cr = await query(
                  `INSERT INTO contacts (tenant_id, email, name, phone, identity_type, identity_name)
                   VALUES ($1,$2,$3,$4,$5,$6)
                   ON CONFLICT (tenant_id, email) DO UPDATE SET
                     name=COALESCE(EXCLUDED.name, contacts.name),
                     phone=COALESCE(EXCLUDED.phone, contacts.phone),
                     identity_type=COALESCE(EXCLUDED.identity_type, contacts.identity_type),
                     identity_name=COALESCE(EXCLUDED.identity_name, contacts.identity_name),
                     updated_at=NOW()
                   RETURNING id`,
                  [tenantId, r.email, r.name, r.phone, r.identity_type, r.identity_name]
                );
                const contactId = cr.rows[0].id;
                const lr = await query(
                  `INSERT INTO list_contacts (list_id, contact_id)
                   VALUES ($1,$2)
                   ON CONFLICT (list_id, contact_id) DO NOTHING
                   RETURNING id`,
                  [listId, contactId]
                );
                if (lr.rowCount > 0) added += 1; else upserts += 1;
              } catch (e) {
                errors += 1;
                if (errorSamples.length < 3) errorSamples.push({ row: r, error: e.message });
              }
            }
          }
        }
      }

      // Audit log successful import
      await logAuditEvent(
        tenantId,
        'csv_upload',
        dryRun ? 'validated' : 'imported',
        'list',
        listId,
        userIdentifier,
        {
          fileSize,
          fileSizeMB,
          rowCount: rows.length,
          processed,
          added,
          upserts,
          errors,
          dryRun
        }
      );

      return res.json({ 
        success: true, 
        data: { processed, added, upserts, errors, errorSamples } 
      });
    } catch (e) {
      logger.error({ err: e, tenantId, listId }, 'CSV import failed');
      
      await logAuditEvent(
        tenantId,
        'csv_upload',
        'failed',
        'list',
        listId,
        userIdentifier,
        { 
          error: e.message,
          stack: e.stack
        }
      );
      
      return res.status(500).json({ 
        success: false, 
        error: 'CSV import failed',
        message: e.message
      });
    }
  }
);



// Export contacts from a list as CSV
router.get('/lists/:id/contacts/export', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify list belongs to tenant
    const listCheck = await query(
      'SELECT id FROM lists WHERE id = $1 AND tenant_id = $2',
      [id, req.tenantId]
    );
    
    if (listCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'List not found' });
    }
    
    // Get all contacts in list
    const contactsQuery = `
      SELECT 
        c.email,
        c.name,
        c.phone,
        c.identity_type,
        c.identity_name,
        c.consent_given_at,
        c.created_at,
        lc.created_at as added_at
      FROM list_contacts lc
      JOIN contacts c ON lc.contact_id = c.id
      WHERE lc.list_id = $1 AND c.tenant_id = $2
      ORDER BY c.email
    `;
    
    const contacts = await query(contactsQuery, [id, req.tenantId]);
    
    // Generate CSV
    const csvRows = [];
    csvRows.push('email,name,phone,identity_type,identity_name,consent_given_at,created_at,added_to_list_at');
    
    contacts.rows.forEach(contact => {
      const row = [
        contact.email || '',
        contact.name || '',
        contact.phone || '',
        contact.identity_type || '',
        contact.identity_name || '',
        contact.consent_given_at ? new Date(contact.consent_given_at).toISOString() : '',
        contact.created_at ? new Date(contact.created_at).toISOString() : '',
        contact.added_at ? new Date(contact.added_at).toISOString() : ''
      ];
      csvRows.push(row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(','));
    });
    
    const csv = csvRows.join('\n');
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-export-${id}-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send('\ufeff' + csv); // UTF-8 BOM for Excel compatibility
  } catch (e) {
    console.error('Export contacts error:', e);
    res.status(500).json({ success: false, error: 'Failed to export contacts' });
  }
});
