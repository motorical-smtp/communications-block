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

// Delete a single template
router.delete('/templates/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const chk = await query('SELECT id FROM templates WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (chk.rowCount === 0) return res.status(404).json({ success: false, error: 'Not found' });
    await query('DELETE FROM templates WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Template deleted' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to delete template' });
  }
});

// Bulk delete templates: body { ids: [uuid...] }
router.delete('/templates', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ success: false, error: 'ids[] required' });
    await query('DELETE FROM templates WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [req.tenantId, ids]);
    res.json({ success: true, message: 'Templates deleted' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to bulk delete templates' });
  }
});

export default router;


