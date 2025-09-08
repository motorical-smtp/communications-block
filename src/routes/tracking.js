import express from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const router = express.Router();

function requireTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
  req.tenantId = tenantId;
  next();
}

function getSettingsDefaults() {
  return { unsubscribe_mode: 'customer', custom_unsubscribe_url: null };
}

function isHttpsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// GET tenant unsubscribe settings
router.get('/api/settings/unsubscribe', requireTenant, async (req, res) => {
  try {
    const r = await query('SELECT unsubscribe_mode, custom_unsubscribe_url FROM tenant_settings WHERE tenant_id=$1', [req.tenantId]);
    const data = r.rowCount > 0 ? r.rows[0] : getSettingsDefaults();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
});

// PATCH tenant unsubscribe settings
router.patch('/api/settings/unsubscribe', requireTenant, async (req, res) => {
  try {
    const { unsubscribe_mode, custom_unsubscribe_url } = req.body || {};
    if (unsubscribe_mode && !['customer', 'motorical'].includes(unsubscribe_mode)) {
      return res.status(400).json({ success: false, error: 'unsubscribe_mode must be customer|motorical' });
    }
    if (custom_unsubscribe_url && !isHttpsUrl(custom_unsubscribe_url)) {
      return res.status(400).json({ success: false, error: 'custom_unsubscribe_url must be HTTPS' });
    }
    const r = await query('SELECT id FROM tenant_settings WHERE tenant_id=$1', [req.tenantId]);
    if (r.rowCount === 0) {
      await query(
        `INSERT INTO tenant_settings (tenant_id, unsubscribe_mode, custom_unsubscribe_url)
         VALUES ($1, $2, $3)`,
        [req.tenantId, unsubscribe_mode || 'customer', custom_unsubscribe_url || null]
      );
    } else {
      await query(
        `UPDATE tenant_settings SET
           unsubscribe_mode=COALESCE($2, unsubscribe_mode),
           custom_unsubscribe_url=COALESCE($3, custom_unsubscribe_url),
           updated_at=NOW()
         WHERE tenant_id=$1`,
        [req.tenantId, unsubscribe_mode || null, custom_unsubscribe_url || null]
      );
    }
    res.json({ success: true, message: 'Settings updated' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// Helper used later by sender to generate tokens (exported)
export function signUnsubscribeToken({ tenantId, campaignId, contactId, ttl = '7d' }) {
  const secret = process.env.SERVICE_JWT_SECRET || 'dev-secret';
  return jwt.sign({ tenantId, campaignId, contactId, t: 'unsub' }, secret, { expiresIn: ttl });
}

function maskEmail(email) {
  try {
    const [local, domain] = String(email).split('@');
    if (!domain) return 'hidden';
    const shown = local.slice(0, 2);
    return `${shown}***@${domain}`;
  } catch (_) {
    return 'hidden';
  }
}

async function recordUnsubscribe({ tenantId, campaignId, contactId, landingVariant }) {
  // Lookup email and motorical_account_id from contact and tenant
  const cr = await query(
    `SELECT c.email, t.motorical_account_id 
     FROM contacts c 
     JOIN tenants t ON t.id = c.tenant_id 
     WHERE c.id=$1 AND c.tenant_id=$2`, 
    [contactId, tenantId]
  );
  if (cr.rowCount === 0) return null;
  const { email, motorical_account_id } = cr.rows[0];
  
  // Insert customer-scoped suppression
  await query(
    `INSERT INTO suppressions (motorical_account_id, tenant_id, email, reason, source, landing_variant)
     VALUES ($1,$2,$3,'unsubscribe','link',$4)
     ON CONFLICT (motorical_account_id, email) DO NOTHING`,
    [motorical_account_id, tenantId, email, landingVariant]
  );
  
  // Update contact status
  await query(`UPDATE contacts SET status='unsubscribed', updated_at=NOW() WHERE id=$1 AND tenant_id=$2`, [contactId, tenantId]);
  
  // Record event
  await query(
    `INSERT INTO email_events (tenant_id, campaign_id, contact_id, type, payload)
     VALUES ($1,$2,$3,'complained', $4)`,
    [tenantId, campaignId, contactId, JSON.stringify({ reason: 'unsubscribe' })]
  );
  
  return { email };
}

async function getTenantSettings(tenantId) {
  const r = await query('SELECT unsubscribe_mode, custom_unsubscribe_url FROM tenant_settings WHERE tenant_id=$1', [tenantId]);
  return r.rowCount > 0 ? r.rows[0] : getSettingsDefaults();
}

// GET/POST /t/u/:token — idempotent unsubscribe then redirect/render
async function handleUnsub(req, res) {
  try {
    const { token } = req.params;
    const secret = process.env.SERVICE_JWT_SECRET || 'dev-secret';
    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch (err) {
      res.status(400).send('<html><body>Unsubscribe link invalid or expired.</body></html>');
      return;
    }
    if (decoded.t !== 'unsub') {
      res.status(400).send('<html><body>Invalid unsubscribe token.</body></html>');
      return;
    }
    const tenantId = decoded.tenantId;
    const campaignId = decoded.campaignId;
    const contactId = decoded.contactId;

    const settings = await getTenantSettings(tenantId);
    const variant = settings.unsubscribe_mode === 'customer' ? 'customer' : 'motorical';

    const info = await recordUnsubscribe({ tenantId, campaignId, contactId, landingVariant: variant });
    const masked = maskEmail(info?.email || '');

    if (variant === 'customer' && settings.custom_unsubscribe_url && isHttpsUrl(settings.custom_unsubscribe_url)) {
      const url = new URL(settings.custom_unsubscribe_url);
      url.searchParams.set('status', 'unsubscribed');
      url.searchParams.set('email', masked);
      url.searchParams.set('campaign', String(campaignId));
      res.redirect(302, url.toString());
      return;
    }

    // Motorical-hosted confirmation
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title></head><body>
      <h3>You've been unsubscribed.</h3>
      <p>${masked ? `Address: ${masked}` : ''}</p>
      <p>Status: unsubscribed</p>
    </body></html>`);
  } catch (e) {
    res.status(500).send('<html><body>Unsubscribe failed. Please try again later.</body></html>');
  }
}

router.get('/t/u/:token', handleUnsub);
router.post('/t/u/:token', handleUnsub);

export default router;


