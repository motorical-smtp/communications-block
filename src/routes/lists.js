import express from 'express';
import { query } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';
import multer from 'multer';
import { parse } from 'csv-parse/sync';

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
    const { name, description } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const r = await query(
      'INSERT INTO lists (tenant_id, name, description) VALUES ($1,$2,$3) RETURNING id, name, description, created_at',
      [req.tenantId, name, description || null]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to create list' });
  }
});

router.get('/lists', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const r = await query('SELECT id, name, description, created_at FROM lists WHERE tenant_id=$1 ORDER BY created_at DESC', [req.tenantId]);
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
    const { emails } = req.body || {};
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ success: false, error: 'emails[] required' });
    }

    const added = [];
    for (const e of emails) {
      const { email, name, phone, identity_type, identity_name } = e;
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
        [req.tenantId, email, name || null, phone || null, identity_type || null, identity_name || null]
      );
      const contactId = cr.rows[0].id;
      await query(
        `INSERT INTO list_contacts (list_id, contact_id)
         VALUES ($1, $2) ON CONFLICT (list_id, contact_id) DO NOTHING`,
        [req.params.id, contactId]
      );
      added.push({ id: contactId, email: cr.rows[0].email });
    }

    res.json({ success: true, data: { addedCount: added.length } });
  } catch (e) {
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
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/lists/:id/contacts/import', requireTenant, requireEntitledTenant, upload.single('file'), async (req, res) => {
  try {
    const dryRun = String(req.query.dryRun || req.body?.dryRun || 'false').toLowerCase() === 'true';
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, error: 'CSV file required (multipart form field "file")' });
    const csvText = req.file.buffer.toString('utf8');
    const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
    let processed = 0; let added = 0; let upserts = 0; let errors = 0;
    const errorSamples = [];

    for (const row of rows) {
      processed += 1;
      const email = String(row.email || '').trim().toLowerCase();
      if (!email) { errors += 1; if (errorSamples.length < 3) errorSamples.push({ row, error: 'missing email' }); continue; }
      const name = row.name || null;
      const phone = row.phone || null;
      const identity_type = row.identity_type || null;
      const identity_name = row.identity_name || null;
      if (dryRun) continue;
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
          [req.tenantId, email, name, phone, identity_type, identity_name]
        );
        const contactId = cr.rows[0].id;
        const lr = await query(
          `INSERT INTO list_contacts (list_id, contact_id)
           VALUES ($1,$2)
           ON CONFLICT (list_id, contact_id) DO NOTHING
           RETURNING id`,
          [req.params.id, contactId]
        );
        if (lr.rowCount > 0) added += 1; else upserts += 1;
      } catch (e) {
        errors += 1; if (errorSamples.length < 3) errorSamples.push({ row, error: e.message });
      }
    }

    return res.json({ success: true, data: { processed, added, upserts, errors, errorSamples } });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'CSV import failed' });
  }
});


