import 'dotenv/config';
import pino from 'pino';
import { query } from '../db.js';
import { getLatestArtifact } from '../repo/compile.js';
import nodemailer from 'nodemailer';
import Redis from 'ioredis';
import { motoricalQuery } from '../dbMotorical.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const MOTORICAL_BASE = process.env.MOTORICAL_API_BASE || 'https://api.motorical.com';
const MOTORICAL_API_KEY = process.env.MOTORICAL_API_KEY || '';
const DEFAULT_FROM = process.env.COMM_FROM_ADDRESS || 'no-reply@motorical.com';
const COMM_PUBLIC_BASE = process.env.COMM_PUBLIC_BASE || 'http://localhost:3011';

// in-memory pacing and locking per campaign (not persisted; MVP only)
const nextAllowedAt = new Map(); // campaignId -> timestamp ms
const inFlightCampaigns = new Set(); // campaignId currently processing
let isTicking = false; // prevent overlapping ticks

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderTemplate(template, contact) {
  // Very simple variable replacement MVP
  const vars = {
    name: contact.name || '',
    identity_name: contact.identity_name || ''
  };
  const subject = (template.subject || '').replace(/\{\{\s*name\s*\}\}/g, vars.name).replace(/\{\{\s*identity_name\s*\}\}/g, vars.identity_name);
  const bodyHtml = (template.body_html || '').replace(/\{\{\s*name\s*\}\}/g, vars.name).replace(/\{\{\s*identity_name\s*\}\}/g, vars.identity_name);
  const bodyText = (template.body_text || '').replace(/\{\{\s*name\s*\}\}/g, vars.name).replace(/\{\{\s*identity_name\s*\}\}/g, vars.identity_name);
  return { subject, bodyHtml, bodyText };
}

async function renderFromArtifact(artifact, contact, { campaignId, tenantId } = {}) {
  const vars = {
    name: contact.name || '',
    identity_name: contact.identity_name || ''
  };
  const subject = String(artifact.subject || '')
    .replace(/\{\{\s*name\s*\}\}/g, vars.name)
    .replace(/\{\{\s*identity_name\s*\}\}/g, vars.identity_name);
  
  let bodyHtml = String(artifact.html_compiled || '')
    .replace(/\{\{\s*name\s*\}\}/g, vars.name)
    .replace(/\{\{\s*identity_name\s*\}\}/g, vars.identity_name);
  
  // Replace tracking token placeholders with actual JWT tokens
  if (campaignId && tenantId && contact.contact_id) {
    bodyHtml = await replaceTrackingTokens(bodyHtml, {
      campaignId,
      tenantId,
      contactId: contact.contact_id
    });
  }
    
  const bodyText = String(artifact.text_compiled || '')
    .replace(/\{\{\s*name\s*\}\}/g, vars.name)
    .replace(/\{\{\s*identity_name\s*\}\}/g, vars.identity_name);
  return { subject, bodyHtml, bodyText };
}

async function replaceTrackingTokens(html, { campaignId, tenantId, contactId }) {
  // Import the JWT token signer - dynamic import to avoid circular dependencies
  const { signClickToken } = await import('../routes/tracking.js');
  
  // Replace TRACK_TOKEN_campaignId_linkIndex patterns with actual JWT tokens
  return html.replace(/TRACK_TOKEN_([^_]+)_(\d+)/g, (match, campId, linkIndex) => {
    if (campId === campaignId) {
      try {
        // Extract the original URL from the tracking link
        const urlMatch = html.match(new RegExp(`/c/${match}\\?url=([^"\\s&]+)`));
        const originalUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : '';
        
        return signClickToken({
          tenantId,
          campaignId,
          contactId,
          originalUrl,
          linkIndex: parseInt(linkIndex),
          ttl: '90d'
        });
      } catch (error) {
        logger.warn({ error: error.message, campaignId, linkIndex }, 'Failed to generate click token');
        return match; // Keep placeholder if token generation fails
      }
    }
    return match;
  });
}

async function getDueCampaigns() {
  const r = await query(
    `SELECT c.id, c.tenant_id, c.template_id, c.motor_block_id, c.from_address, c.from_name, c.name,
            COALESCE(css.chunk_size, 100) AS chunk_size,
            COALESCE(css.delay_seconds_between_chunks, 30) AS delay_sec
     FROM campaigns c
     LEFT JOIN campaign_send_settings css ON css.campaign_id = c.id
     WHERE c.status IN ('scheduled', 'sending')
       AND (c.scheduled_at IS NULL OR c.scheduled_at <= NOW())`
  );
  return r.rows;
}

async function ensureSendingStatus(campaignId) {
  await query(`UPDATE campaigns SET status='sending' WHERE id=$1 AND status='scheduled'`, [campaignId]);
}

async function getTemplate(templateId, tenantId) {
  const r = await query(`SELECT id, subject, type, body_html, body_text FROM templates WHERE id=$1 AND tenant_id=$2`, [templateId, tenantId]);
  return r.rows[0] || null;
}

async function getProcessedContactIds(campaignId) {
  const r = await query(`SELECT DISTINCT contact_id FROM email_events WHERE campaign_id=$1`, [campaignId]);
  return new Set(r.rows.filter((x) => x.contact_id).map((x) => x.contact_id));
}

async function getCandidateRecipients(campaignId, tenantId, limit) {
  // Exclude suppressed/unsubscribed and dedupe by email
  // Now using customer-scoped suppressions via motorical_account_id
  const r = await query(
    `SELECT c.id AS contact_id, c.email, c.name, c.identity_name
     FROM campaign_lists cl
     JOIN list_contacts lc ON lc.list_id = cl.list_id AND lc.status='active'
     JOIN contacts c ON c.id = lc.contact_id AND c.status='active'
     JOIN tenants t ON t.id = c.tenant_id
     LEFT JOIN suppressions s ON s.motorical_account_id = t.motorical_account_id AND s.email = c.email
     WHERE cl.campaign_id=$1 AND c.tenant_id=$2 AND s.email IS NULL`,
    [campaignId, tenantId]
  );
  const dedup = new Map();
  for (const row of r.rows) {
    const key = String(row.email).toLowerCase();
    if (!dedup.has(key)) dedup.set(key, row);
  }
  return Array.from(dedup.values()).slice(0, limit * 5); // broad fetch; will shrink after removing processed
}

async function recordEvent({ tenantId, campaignId, contactId, messageId, motorBlockId, type, payload }) {
  await query(
    `INSERT INTO email_events (tenant_id, campaign_id, contact_id, message_id, motor_block_id, type, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, campaignId, contactId || null, messageId || null, motorBlockId || null, type, payload ? JSON.stringify(payload) : null]
  );
}

async function sendOne({ from, to, subject, text, html, metadata, headers, motorBlockId }) {
  // Prefer SMTP if explicit creds provided (ensures real send during MVP/testing)
  const smtpEnabled = process.env.COMM_SMTP_ENABLE === 'true';
  const smtpHost = process.env.COMM_SMTP_HOST || 'mail.motorical.com';
  const smtpPort = Number(process.env.COMM_SMTP_PORT || 2587);
  const smtpUser = process.env.COMM_SMTP_USER || '';
  const smtpPass = process.env.COMM_SMTP_PASS || '';
  if (smtpEnabled && smtpUser && smtpPass) {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: false,
      auth: { user: smtpUser, pass: smtpPass }
    });
    const info = await transporter.sendMail({ from, to, subject, text, html, headers });
    return { success: true, data: { status: 'queued', messageId: info?.messageId || null } };
  }

  // Proper path: enqueue directly for delivery via motor block
  if (!motorBlockId) {
    throw new Error('motorBlockId is required for sending');
  }

  // Insert into email_logs and push to delivery queue
  const toAddress = Array.isArray(to) ? to[0] : to;
  const meta = metadata || {};
  const contentMeta = meta.content || {};
  const allRecipients = meta.allRecipients || { to: Array.isArray(to) ? to : [to] };

  const insert = await motoricalQuery(
    `INSERT INTO email_logs (
       id, motor_block_id, message_id, from_address, to_address, subject, body_size, status, metadata
     ) VALUES (
       gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'queued', $7::jsonb
     ) RETURNING id`,
    [
      motorBlockId,
      null,
      from,
      toAddress,
      subject,
      Buffer.byteLength(String(html || text || ''), 'utf8'),
      JSON.stringify({
        allRecipients,
        content: {
          bodyText: text || '',
          bodyHtml: html || ''
        },
        attachments: meta.attachments || [],
        // Include campaign metadata for logs API correlation
        campaign_id: meta.campaign_id || null,
        tenant_id: meta.tenant_id || null,
        contact_id: meta.contact_id || null
      })
    ]
  );
  const emailId = insert.rows[0]?.id;

  const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || ''
  });
  try {
    // Extract domain from email, handling formats like "Name" <email@domain.com>
    const domain = String(from).split('@')[1]?.replace(/[<>\s"]/g, '') || '';
    const queueData = {
      emailId,
      motorBlockId,
      fromAddress: from,
      toAddresses: allRecipients.to,
      subject,
      bodyText: text || '',
      bodyHtml: html || '',
      rawMessage: '',
      attachments: meta.attachments || [],
      domain,
      priority: 'normal',
      attempts: 0,
      createdAt: new Date().toISOString(),
      headers: headers || {}, // ✅ ADD: Pass headers through queue
      metadata: meta // ✅ ADD: Include full metadata for campaign info
    };
    
    // Debug: Log what we're queuing
    if (headers && Object.keys(headers).length > 0) {
      logger.info('Queuing email with headers', { 
        emailId, 
        from, 
        headersCount: Object.keys(headers).length,
        headerKeys: Object.keys(headers)
      });
    } else {
      logger.warn('Queuing email WITHOUT headers', { emailId, from, hasHeaders: !!headers });
    }
    await redis.lpush('email_delivery_queue', JSON.stringify(queueData));
  } finally {
    redis.disconnect();
  }

  return { success: true, data: { status: 'queued', messageId: emailId } };
}

async function processCampaign(c) {
  const startTs = Date.now();
  const now = Date.now();
  if (nextAllowedAt.has(c.id) && now < nextAllowedAt.get(c.id)) {
    return; // honor delay between chunks
  }

  if (inFlightCampaigns.has(c.id)) {
    // Another tick already processing this campaign; skip to avoid duplicate sends
    return;
  }

  inFlightCampaigns.add(c.id);

  try {
    await ensureSendingStatus(c.id);
    const template = await getTemplate(c.template_id, c.tenant_id);
    if (!template) {
      logger.warn({ campaignId: c.id }, 'template missing; skipping campaign');
      return;
    }

    // Prefer compiled artifact when available for immutability and parity
    const latestArtifact = await getLatestArtifact(c.id, c.tenant_id).catch(() => null);

  // Clamp settings defensively to ensure robust pacing
  const chunkSize = Math.max(1, Math.min(1000, Number(c.chunk_size) || 100));
  const delaySec = Math.max(1, Math.min(86400, Number(c.delay_sec) || 30));

  const processed = await getProcessedContactIds(c.id);
  const candidates = await getCandidateRecipients(c.id, c.tenant_id, chunkSize);
  const remaining = candidates.filter((r) => !processed.has(r.contact_id));
  const batch = remaining.slice(0, chunkSize);
    if (batch.length === 0) {
      logger.info({ campaignId: c.id }, 'no recipients remaining; completing');
      // nothing to send, mark complete
      await query(`UPDATE campaigns SET status='completed' WHERE id=$1 AND status='sending'`, [c.id]);
      return;
    }

    logger.info({ campaignId: c.id, candidates: candidates.length, processed: processed.size, batch: batch.length }, 'processing batch');
    for (const recipient of batch) {
      try {
        const rendered = latestArtifact ? 
          await renderFromArtifact(latestArtifact, recipient, { campaignId: c.id, tenantId: c.tenant_id }) : 
          renderTemplate(template, recipient);
        // Generate unsubscribe URL token and inject into HTML/text if present
        let unsubscribeUrl = null;
        try {
          const { signUnsubscribeToken } = await import('../routes/tracking.js');
          const token = signUnsubscribeToken({ tenantId: c.tenant_id, campaignId: c.id, contactId: recipient.contact_id, ttl: '30d' });
          unsubscribeUrl = `${COMM_PUBLIC_BASE}/t/u/${token}`;
        } catch (_) {}
        // Prepare List-Unsubscribe headers (HTTP + mailto fallback)
        const mailtoAddress = process.env.COMM_UNSUB_MAILTO || 'unsubscribe@motorical.com';
        const listUnsub = unsubscribeUrl ? `<${unsubscribeUrl}>, <mailto:${mailtoAddress}>` : `<mailto:${mailtoAddress}>`;
        const listUnsubPost = 'List-Unsubscribe=One-Click';
        const htmlWithUnsub = rendered.bodyHtml && unsubscribeUrl ? rendered.bodyHtml.replace(/\{\{\s*unsubscribe_url\s*\}\}/g, unsubscribeUrl) : rendered.bodyHtml;
        const textWithUnsub = rendered.bodyText && unsubscribeUrl ? rendered.bodyText.replace(/\{\{\s*unsubscribe_url\s*\}\}/g, unsubscribeUrl) : rendered.bodyText;
        // Use campaign's from_address if set, otherwise fall back to DEFAULT_FROM from env
        const fromAddress = (c.from_address && c.from_address.trim()) ? c.from_address.trim() : DEFAULT_FROM;
        if (!c.from_address || !c.from_address.trim()) {
          logger.warn({ campaignId: c.id, campaignName: c.name, defaultFrom: DEFAULT_FROM }, `Campaign missing from_address, using default from env: ${DEFAULT_FROM}`);
        } else {
          logger.info({ campaignId: c.id, fromAddress }, `Using campaign from_address: ${fromAddress}`);
        }
        
        // Format From header with from_name (preferred) or campaign name (fallback)
        // Priority: from_name > campaign name > email only
        const displayName = (c.from_name && c.from_name.trim()) || (c.name && c.name.trim()) || null;
        const fromHeader = displayName ? `"${displayName}" <${fromAddress}>` : fromAddress;
        
        // Debug: Log display name source and fromHeader
        if (!displayName) {
          logger.warn('No display name available, From header will not include display name', { 
            campaignId: c.id, 
            fromHeader,
            fromAddress,
            hasFromName: !!(c.from_name && c.from_name.trim()),
            hasCampaignName: !!(c.name && c.name.trim())
          });
        } else {
          logger.info('Formatted From header with display name', { 
            campaignId: c.id,
            displayName,
            displayNameSource: (c.from_name && c.from_name.trim()) ? 'from_name' : 'campaign_name',
            fromHeader,
            fromAddress 
          });
        }
        
        // Build headers with all required fields
        const emailHeaders = {
          'List-Unsubscribe': listUnsub,
          'List-Unsubscribe-Post': listUnsubPost,
          'Reply-To': fromAddress,
          'Precedence': 'bulk',
          'X-Auto-Response-Suppress': 'All',
          'Feedback-ID': `${c.tenant_id}:${c.id}:campaign:Motorical`
        };
        
        const payload = {
          from: fromHeader, // ✅ FIX: Include campaign name in From header
          to: recipient.email,
          subject: rendered.subject,
          text: textWithUnsub || undefined,
          html: htmlWithUnsub || undefined,
          metadata: {
            campaign_id: c.id,
            campaign_name: c.name, // ✅ ADD: Include campaign name in metadata
            tenant_id: c.tenant_id, // ✅ ADD: Include tenant_id for Feedback-ID
            contact_id: recipient.contact_id,
            allRecipients: { to: [recipient.email] },
            content: { bodyText: rendered.bodyText || '', bodyHtml: rendered.bodyHtml || '' }
          },
          headers: emailHeaders
        };
        // Idempotency key per recipient send: campaignId:contactId
        const idempotencyKey = `${c.id}:${recipient.contact_id}`;

        // Simple retry with backoff for transient errors
        const maxAttempts = 3;
        let attempt = 0;
        let result = null;
        while (attempt < maxAttempts) {
          try {
            result = await sendOne({ ...payload, motorBlockId: c.motor_block_id });
            break;
          } catch (err) {
            attempt += 1;
            if (attempt >= maxAttempts) throw err;
            const backoffMs = 500 * Math.pow(2, attempt - 1);
            logger.warn({ attempt, backoffMs, err: String(err?.message || err) }, 'send retry');
            await sleep(backoffMs);
          }
        }
        let messageId = result?.data?.messageId || null;
        if (typeof messageId === 'string') {
          messageId = messageId.trim().replace(/^<|>$/g, '');
        }
        // Record queued event (email_logs.id as messageId for correlation)
        // The stats worker will create 'sent'/'delivered'/'bounced' events when polling logs API
        await recordEvent({
          tenantId: c.tenant_id,
          campaignId: c.id,
          contactId: recipient.contact_id,
          messageId, // This is email_logs.id (UUID), used for correlation
          motorBlockId: c.motor_block_id,
          type: 'queued',
          payload: { ...(result || {}), idempotencyKey }
        });
      } catch (err) {
        logger.error({ err, campaignId: c.id, email: recipient.email }, 'send failed');
        await recordEvent({
          tenantId: c.tenant_id,
          campaignId: c.id,
          contactId: recipient.contact_id,
          messageId: null,
          motorBlockId: c.motor_block_id,
          type: 'failed',
          payload: { error: String(err?.message || err) }
        });
      }
    }

    // set delay before next chunk
    nextAllowedAt.set(c.id, Date.now() + (delaySec * 1000));
    logger.info({ campaignId: c.id, ms: Date.now() - startTs }, 'batch processed');
  } finally {
    inFlightCampaigns.delete(c.id);
  }
}

async function tick() {
  try {
    const campaigns = await getDueCampaigns();
    if (campaigns.length > 0) {
      logger.info({ count: campaigns.length }, 'due campaigns found');
    }
    for (const c of campaigns) {
      await processCampaign(c);
    }
  } catch (err) {
    logger.error({ err }, 'tick error');
  }
}

async function main() {
  logger.info('communications-block sender started');
  setInterval(() => logger.info('sender worker heartbeat'), 30000);
  // main loop with overlap guard
  setInterval(async () => {
    if (isTicking) return; // skip if previous tick still running
    isTicking = true;
    try {
      await tick();
    } catch (e) {
      logger.error({ err: e }, 'tick outer error');
    } finally {
      isTicking = false;
    }
  }, 5000);
}

main().catch((err) => {
  logger.error({ err }, 'sender crashed');
  process.exit(1);
});


