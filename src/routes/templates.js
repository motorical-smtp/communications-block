import express from 'express';
import * as cheerio from 'cheerio';
import { query } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';

const router = express.Router();

function requireTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
  req.tenantId = tenantId;
  next();
}

const TEMPLATE_LIMITS = {
  maxHtmlSize: 500 * 1024,
  maxDomNodes: 2000,
  maxLinks: 100,
  maxImages: 50,
  maxTextLength: 100 * 1024,
  maxSubjectLength: 998
};

const DEFAULT_SAMPLE_DATA = {
  name: 'Demo User',
  email: 'demo@example.com',
  identity_name: 'Demo Company',
  unsubscribe_url: 'https://example.com/unsubscribe'
};

function renderWithSampleData(value = '', sampleData = {}) {
  const data = { ...DEFAULT_SAMPLE_DATA, ...sampleData };
  return String(value).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(data, key) ? String(data[key]) : match;
  });
}

function collectMergeVariables(...values) {
  const vars = new Set();
  for (const value of values) {
    const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
    let match;
    while ((match = re.exec(String(value || '')))) vars.add(match[1]);
  }
  return Array.from(vars).sort();
}

function validateTemplatePayload(payload = {}) {
  const { name, subject, type, body_html, body_text, sampleData } = payload;
  const warnings = [];
  const errors = [];
  const metrics = {
    htmlSize: Buffer.byteLength(String(body_html || ''), 'utf8'),
    textLength: String(body_text || '').length,
    subjectLength: String(subject || '').length,
    nodeCount: 0,
    linkCount: 0,
    imageCount: 0,
    mergeVariables: collectMergeVariables(subject, body_html, body_text)
  };

  if (!name) errors.push({ type: 'missing_name', field: 'name', message: 'name is required' });
  if (!subject) errors.push({ type: 'missing_subject', field: 'subject', message: 'subject is required' });
  if (!type) errors.push({ type: 'missing_type', field: 'type', message: 'type is required' });
  if (type && !['html', 'text'].includes(type)) {
    errors.push({ type: 'invalid_type', field: 'type', message: 'type must be html or text' });
  }
  if (subject && metrics.subjectLength > TEMPLATE_LIMITS.maxSubjectLength) {
    errors.push({ type: 'subject_too_long', field: 'subject', message: `subject exceeds ${TEMPLATE_LIMITS.maxSubjectLength} characters`, limit: TEMPLATE_LIMITS.maxSubjectLength, actual: metrics.subjectLength });
  }
  if (type === 'html' && !body_html) {
    errors.push({ type: 'missing_body_html', field: 'body_html', message: 'body_html is required when type is html' });
  }
  if (type === 'text' && !body_text) {
    errors.push({ type: 'missing_body_text', field: 'body_text', message: 'body_text is required when type is text' });
  }
  if (type === 'html' && !body_text) {
    warnings.push({ type: 'missing_text_fallback', field: 'body_text', message: 'HTML templates should include body_text as a plain-text fallback' });
  }

  const unsubscribePresent = [body_html, body_text].some((value) => String(value || '').includes('{{unsubscribe_url}}'));
  if (!unsubscribePresent) {
    warnings.push({ type: 'missing_unsubscribe_url', message: 'Include {{unsubscribe_url}} so campaigns can render an unsubscribe link' });
  }

  if (metrics.htmlSize > TEMPLATE_LIMITS.maxHtmlSize) {
    errors.push({ type: 'html_size_exceeded', field: 'body_html', message: `HTML size (${Math.round(metrics.htmlSize / 1024)}KB) exceeds limit (${Math.round(TEMPLATE_LIMITS.maxHtmlSize / 1024)}KB)`, limit: TEMPLATE_LIMITS.maxHtmlSize, actual: metrics.htmlSize });
  } else if (metrics.htmlSize > TEMPLATE_LIMITS.maxHtmlSize * 0.8) {
    warnings.push({ type: 'html_size_warning', field: 'body_html', message: `HTML size (${Math.round(metrics.htmlSize / 1024)}KB) is approaching limit (${Math.round(TEMPLATE_LIMITS.maxHtmlSize / 1024)}KB)`, limit: TEMPLATE_LIMITS.maxHtmlSize, actual: metrics.htmlSize });
  }

  if (metrics.textLength > TEMPLATE_LIMITS.maxTextLength) {
    warnings.push({ type: 'text_length_warning', field: 'body_text', message: `Text content (${Math.round(metrics.textLength / 1024)}KB) exceeds recommended limit (${Math.round(TEMPLATE_LIMITS.maxTextLength / 1024)}KB)`, limit: TEMPLATE_LIMITS.maxTextLength, actual: metrics.textLength });
  }

  if (body_html) {
    const $ = cheerio.load(body_html);
    metrics.nodeCount = $('*').length;
    metrics.linkCount = $('a[href]').length;
    metrics.imageCount = $('img').length;

    if (metrics.nodeCount > TEMPLATE_LIMITS.maxDomNodes) {
      errors.push({ type: 'dom_nodes_exceeded', field: 'body_html', message: `DOM node count (${metrics.nodeCount}) exceeds limit (${TEMPLATE_LIMITS.maxDomNodes})`, limit: TEMPLATE_LIMITS.maxDomNodes, actual: metrics.nodeCount });
    } else if (metrics.nodeCount > TEMPLATE_LIMITS.maxDomNodes * 0.8) {
      warnings.push({ type: 'dom_nodes_warning', field: 'body_html', message: `DOM node count (${metrics.nodeCount}) is approaching limit (${TEMPLATE_LIMITS.maxDomNodes})`, limit: TEMPLATE_LIMITS.maxDomNodes, actual: metrics.nodeCount });
    }

    if (metrics.linkCount > TEMPLATE_LIMITS.maxLinks) {
      errors.push({ type: 'links_exceeded', field: 'body_html', message: `Link count (${metrics.linkCount}) exceeds limit (${TEMPLATE_LIMITS.maxLinks})`, limit: TEMPLATE_LIMITS.maxLinks, actual: metrics.linkCount });
    } else if (metrics.linkCount > TEMPLATE_LIMITS.maxLinks * 0.8) {
      warnings.push({ type: 'links_warning', field: 'body_html', message: `Link count (${metrics.linkCount}) is approaching limit (${TEMPLATE_LIMITS.maxLinks})`, limit: TEMPLATE_LIMITS.maxLinks, actual: metrics.linkCount });
    }

    if (metrics.imageCount > TEMPLATE_LIMITS.maxImages) {
      warnings.push({ type: 'images_warning', field: 'body_html', message: `Image count (${metrics.imageCount}) exceeds recommended limit (${TEMPLATE_LIMITS.maxImages})`, limit: TEMPLATE_LIMITS.maxImages, actual: metrics.imageCount });
    }

    const suspiciousPatterns = [
      { pattern: /<script/gi, type: 'script_tags', message: 'Script tags detected' },
      { pattern: /javascript:/gi, type: 'javascript_urls', message: 'JavaScript URLs detected' },
      { pattern: /on\w+\s*=/gi, type: 'event_handlers', message: 'Event handlers detected' }
    ];
    for (const { pattern, type: warningType, message } of suspiciousPatterns) {
      const matches = body_html.match(pattern);
      if (matches) warnings.push({ type: warningType, field: 'body_html', message: `${message} (${matches.length} instances)`, count: matches.length });
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    metrics,
    preview: {
      subject: renderWithSampleData(subject, sampleData),
      body_html: renderWithSampleData(body_html, sampleData),
      body_text: renderWithSampleData(body_text, sampleData)
    }
  };
}

router.post('/templates/validate', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const result = validateTemplatePayload(req.body || {});
    return res.status(result.valid ? 200 : 422).json({ success: result.valid, data: result });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Failed to validate template' });
  }
});

router.post('/templates', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { name, subject, type, body_html, body_text } = req.body || {};
    const validation = validateTemplatePayload(req.body || {});
    if (!name || !subject || !type) return res.status(400).json({ success: false, error: 'name, subject, type required', validation });
    if (!['html','text'].includes(type)) return res.status(400).json({ success: false, error: 'type must be html or text', validation });
    if (!validation.valid) return res.status(422).json({ success: false, error: 'Template validation failed', validation });
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
