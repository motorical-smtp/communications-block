import express from 'express';
import { query } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';

const router = express.Router();

function requireTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
  req.tenantId = tenantId;
  next();
}

router.post('/templates', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { name, subject, type, body_html, body_text } = req.body || {};
    if (!name || !subject || !type) return res.status(400).json({ success: false, error: 'name, subject, type required' });
    if (!['html','text'].includes(type)) return res.status(400).json({ success: false, error: 'type must be html or text' });
    const r = await query(
      `INSERT INTO templates (tenant_id, name, subject, type, body_html, body_text)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, subject, type, created_at`,
      [req.tenantId, name, subject, type, body_html || null, body_text || null]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to create template' });
  }
});

router.get('/templates', requireTenant, requireEntitledTenant, async (_req, res) => {
  try {
    const r = await query('SELECT id, name, subject, type, created_at FROM templates WHERE tenant_id=$1 ORDER BY created_at DESC', [_req.tenantId]);
    res.json({ success: true, data: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to fetch templates' });
  }
});

router.get('/templates/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const r = await query('SELECT id, name, subject, type, body_html, body_text, created_at FROM templates WHERE tenant_id=$1 AND id=$2', [req.tenantId, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to fetch template' });
  }
});

// Update a template (PATCH)
router.patch('/templates/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { name, subject, body_html, body_text } = req.body || {};
    
    // Check template exists and belongs to tenant
    const existing = await query('SELECT id FROM templates WHERE tenant_id=$1 AND id=$2', [req.tenantId, req.params.id]);
    if (existing.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });
    
    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (subject !== undefined) {
      updates.push(`subject = $${paramIndex++}`);
      values.push(subject);
    }
    if (body_html !== undefined) {
      updates.push(`body_html = $${paramIndex++}`);
      values.push(body_html);
    }
    if (body_text !== undefined) {
      updates.push(`body_text = $${paramIndex++}`);
      values.push(body_text);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    
    // Add updated_at
    updates.push(`updated_at = NOW()`);
    
    // Add WHERE clause params
    values.push(req.tenantId);
    values.push(req.params.id);
    
    const sql = `UPDATE templates SET ${updates.join(', ')} WHERE tenant_id = $${paramIndex++} AND id = $${paramIndex} RETURNING id, name, subject, type, body_html, body_text, created_at, updated_at`;
    
    const r = await query(sql, values);
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    console.error('Template update error:', e);
    res.status(500).json({ success: false, error: 'Failed to update template' });
  }
});

// Delete a single template
router.delete('/templates/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const chk = await query('SELECT id FROM templates WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (chk.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });
    try {
      await query('DELETE FROM templates WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
      return res.json({ success: true, message: 'Template deleted' });
    } catch (err) {
      if (err?.code === '23503') {
        // FK violation: template in use
        return res.status(409).json({ success: false, error: 'Template is in use and cannot be deleted', code: 'TEMPLATE_IN_USE' });
      }
      return res.status(500).json({ success: false, error: 'Failed to delete template' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Failed to delete template' });
  }
});

// Bulk delete templates: body { ids: [uuid...] }
router.delete('/templates', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ success: false, error: 'ids[] required' });

    const deleted = [];
    const failed = [];
    for (const id of ids) {
      try {
        /* eslint-disable no-await-in-loop */
        await query('DELETE FROM templates WHERE tenant_id=$1 AND id=$2::uuid', [req.tenantId, id]);
        deleted.push(id);
      } catch (err) {
        if (err?.code === '23503') {
          failed.push({ id, reason: 'TEMPLATE_IN_USE' });
        } else {
          failed.push({ id, reason: 'UNKNOWN' });
        }
      }
    }

    if (failed.length > 0 && deleted.length === 0) {
      return res.status(409).json({ success: false, error: 'Some templates are in use and cannot be deleted', deleted, failed });
    }
    return res.json({ success: true, message: 'Bulk delete completed', deleted, failed });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Failed to bulk delete templates' });
  }
});

export default router;
