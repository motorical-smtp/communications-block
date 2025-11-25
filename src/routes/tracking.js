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
  const secret = process.env.SERVICE_JWT_SECRET;
  if (!secret) {
    throw new Error('SERVICE_JWT_SECRET environment variable is required for token signing');
  }
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
    const secret = process.env.SERVICE_JWT_SECRET;
    if (!secret) {
      res.status(500).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Configuration Error</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #333;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    .icon { width: 64px; height: 64px; margin: 0 auto 24px; background: #ef4444; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; color: white; }
    h1 { font-size: 24px; font-weight: 600; color: #1f2937; margin-bottom: 16px; }
    p { color: #6b7280; font-size: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⚠</div>
    <h1>Configuration Error</h1>
    <p>Server configuration error: JWT secret not configured.</p>
  </div>
</body>
</html>`);
      return;
    }
    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch (err) {
      res.status(400).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invalid Link</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #333;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    .icon { width: 64px; height: 64px; margin: 0 auto 24px; background: #f59e0b; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; color: white; }
    h1 { font-size: 24px; font-weight: 600; color: #1f2937; margin-bottom: 16px; }
    p { color: #6b7280; font-size: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⚠</div>
    <h1>Invalid or Expired Link</h1>
    <p>This unsubscribe link is invalid or has expired. Please contact the sender directly if you wish to unsubscribe.</p>
  </div>
</body>
</html>`);
      return;
    }
    if (decoded.t !== 'unsub') {
      res.status(400).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invalid Token</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #333;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    .icon { width: 64px; height: 64px; margin: 0 auto 24px; background: #f59e0b; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; color: white; }
    h1 { font-size: 24px; font-weight: 600; color: #1f2937; margin-bottom: 16px; }
    p { color: #6b7280; font-size: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⚠</div>
    <h1>Invalid Unsubscribe Token</h1>
    <p>This unsubscribe link is not valid. Please contact the sender directly if you wish to unsubscribe.</p>
  </div>
</body>
</html>`);
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
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed Successfully</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      line-height: 1.6;
      color: #333;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    .icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      background: #10b981;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
    }
    h1 {
      font-size: 28px;
      font-weight: 600;
      color: #1f2937;
      margin-bottom: 16px;
    }
    .message {
      color: #6b7280;
      font-size: 16px;
      margin-bottom: 24px;
    }
    .info-box {
      background: #f9fafb;
      border-radius: 8px;
      padding: 16px;
      margin-top: 24px;
      text-align: left;
    }
    .info-item {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #e5e7eb;
    }
    .info-item:last-child {
      border-bottom: none;
    }
    .info-label {
      font-weight: 500;
      color: #6b7280;
      font-size: 14px;
    }
    .info-value {
      color: #1f2937;
      font-size: 14px;
      font-weight: 500;
    }
    .status-badge {
      display: inline-block;
      background: #d1fae5;
      color: #065f46;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .footer {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #e5e7eb;
      color: #9ca3af;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✓</div>
    <h1>You've been unsubscribed</h1>
    <p class="message">You will no longer receive emails from this sender.</p>
    ${masked ? `
    <div class="info-box">
      <div class="info-item">
        <span class="info-label">Email Address</span>
        <span class="info-value">${masked}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Status</span>
        <span class="status-badge">Unsubscribed</span>
      </div>
    </div>
    ` : `
    <div class="info-box">
      <div class="info-item">
        <span class="info-label">Status</span>
        <span class="status-badge">Unsubscribed</span>
      </div>
    </div>
    `}
    <div class="footer">
      <p>This change takes effect immediately. If you have any questions, please contact the sender directly.</p>
    </div>
  </div>
</body>
</html>`);
  } catch (e) {
    res.status(500).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #333;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    .icon { width: 64px; height: 64px; margin: 0 auto 24px; background: #ef4444; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; color: white; }
    h1 { font-size: 24px; font-weight: 600; color: #1f2937; margin-bottom: 16px; }
    p { color: #6b7280; font-size: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✕</div>
    <h1>Unsubscribe Failed</h1>
    <p>We encountered an error processing your unsubscribe request. Please try again later or contact the sender directly.</p>
  </div>
</body>
</html>`);
  }
}

router.get('/t/u/:token', handleUnsub);
router.post('/t/u/:token', handleUnsub);

// Helper used by sender to generate click tracking tokens
export function signClickToken({ tenantId, campaignId, contactId, originalUrl, linkIndex, ttl = '90d' }) {
  const secret = process.env.SERVICE_JWT_SECRET;
  return jwt.sign({ 
    tenantId, 
    campaignId, 
    contactId, 
    originalUrl, 
    linkIndex,
    t: 'click' 
  }, secret, { expiresIn: ttl });
}

async function recordClick({ tenantId, campaignId, contactId, originalUrl, linkIndex, userAgent, ip }) {
  try {
    // Record click event in email_events
    await query(
      `INSERT INTO email_events (tenant_id, campaign_id, contact_id, type, payload, occurred_at)
       VALUES ($1, $2, $3, 'clicked', $4, NOW())`,
      [tenantId, campaignId, contactId, JSON.stringify({ 
        originalUrl, 
        linkIndex, 
        userAgent: userAgent?.substring(0, 500), // Limit length
        ip: ip?.substring(0, 45) // IPv6 max length
      })]
    );

    // Update contact last engagement
    await query(
      `UPDATE contacts SET last_engagement_at = NOW(), updated_at = NOW() 
       WHERE id = $1 AND tenant_id = $2`,
      [contactId, tenantId]
    );

    console.log(`Click recorded: campaign=${campaignId}, contact=${contactId}, url=${originalUrl}`);
    return true;
  } catch (error) {
    console.error('Failed to record click:', error);
    return false;
  }
}

// GET/POST /c/:token — click tracking redirect
async function handleClick(req, res) {
  try {
    const { token } = req.params;
    const { url } = req.query;
    const secret = process.env.SERVICE_JWT_SECRET;
    
    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch (err) {
      console.warn('Invalid click token:', err.message);
      // Still redirect to the URL if provided for user experience
      if (url) {
        return res.redirect(302, decodeURIComponent(url));
      }
      return res.status(400).send('<html><body>Invalid tracking link.</body></html>');
    }

    if (decoded.t !== 'click') {
      console.warn('Invalid click token type:', decoded.t);
      if (url || decoded.originalUrl) {
        return res.redirect(302, decodeURIComponent(url || decoded.originalUrl));
      }
      return res.status(400).send('<html><body>Invalid tracking link.</body></html>');
    }

    const { tenantId, campaignId, contactId, originalUrl, linkIndex } = decoded;
    const targetUrl = url ? decodeURIComponent(url) : originalUrl;

    if (!targetUrl) {
      return res.status(400).send('<html><body>Missing destination URL.</body></html>');
    }

    // Record the click (async, don't block redirect)
    const userAgent = req.headers['user-agent'];
    const ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];
    
    recordClick({ 
      tenantId, 
      campaignId, 
      contactId, 
      originalUrl: targetUrl, 
      linkIndex, 
      userAgent, 
      ip 
    }).catch(error => {
      console.error('Click recording failed:', error);
    });

    // Immediate redirect for good user experience
    res.redirect(302, targetUrl);

  } catch (error) {
    console.error('Click handling error:', error);
    const { url } = req.query;
    if (url) {
      return res.redirect(302, decodeURIComponent(url));
    }
    res.status(500).send('<html><body>Tracking failed. Please try again later.</body></html>');
  }
}

router.get('/c/:token', handleClick);
router.post('/c/:token', handleClick);

router.get('/t/u/:token', handleUnsub);

export default router;


