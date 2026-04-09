// GDPR Compliance Routes
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

// GDPR Data Export
router.get('/gdpr/export', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { email, format = 'json' } = req.query;
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email parameter required' });
    }
    
    // Get all data for this email
    const contactQuery = `
      SELECT * FROM contacts
      WHERE email = $1 AND tenant_id = $2
    `;
    const contactResult = await query(contactQuery, [email, req.tenantId]);
    const contact = contactResult.rows[0];
    
    if (!contact) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    
    // Get list memberships
    const listsQuery = `
      SELECT l.id, l.name, lc.created_at as added_at
      FROM list_contacts lc
      JOIN lists l ON lc.list_id = l.id
      WHERE lc.contact_id = $1
    `;
    const lists = await query(listsQuery, [contact.id]);
    
    // Get campaign history (using email_events table)
    const campaignsQuery = `
      SELECT 
        c.id,
        c.name,
        ee.type as status,
        ee.occurred_at as sent_at
      FROM email_events ee
      JOIN campaigns c ON ee.campaign_id = c.id
      WHERE ee.contact_id = $1
      GROUP BY c.id, c.name, ee.type, ee.occurred_at
    `;
    const campaigns = await query(campaignsQuery, [contact.id]);
    
    // Get tracking events
    const trackingQuery = `
      SELECT type, occurred_at, campaign_id FROM email_events
      WHERE contact_id = $1
      ORDER BY occurred_at DESC
    `;
    const tracking = await query(trackingQuery, [contact.id]);
    
    // Get suppression status
    const accountResult = await query(
      `SELECT motorical_account_id FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    const motoricalAccountId = accountResult.rows[0]?.motorical_account_id;
    
    const suppressionQuery = `
      SELECT * FROM suppressions
      WHERE email = $1 AND motorical_account_id = $2
    `;
    const suppression = motoricalAccountId 
      ? await query(suppressionQuery, [email, motoricalAccountId])
      : { rows: [] };
    
    // Get unsubscribe events
    const unsubscribeQuery = `
      SELECT * FROM unsubscribe_events
      WHERE email = $1 AND tenant_id = $2
      ORDER BY created_at DESC
    `;
    const unsubscribeEvents = await query(unsubscribeQuery, [email, req.tenantId]);
    
    // Compile export data
    const exportData = {
      contact,
      lists: lists.rows,
      campaigns_received: campaigns.rows,
      tracking_events: tracking.rows,
      suppression_status: suppression.rows[0] || null,
      unsubscribe_events: unsubscribeEvents.rows,
      exported_at: new Date().toISOString()
    };
    
    // Format and email the data
    let fileContent, contentType, filename;
    const dateStr = new Date().toISOString().split('T')[0];
    
    if (format === 'csv') {
      const csvRows = ['\ufeff']; // BOM for Excel
      const esc = v => !v ? '' : String(v).includes(',') || String(v).includes('"') || String(v).includes('\n') 
        ? '"' + String(v).replace(/"/g, '""') + '"' 
        : String(v);
      
      // CONTACT INFORMATION
      csvRows.push('CONTACT INFORMATION');
      csvRows.push('Field,Value');
      if (contact) {
        const contactFields = {
          'Email': contact.email,
          'Name': contact.name,
          'Phone': contact.phone,
          'Identity Type': contact.identity_type,
          'Identity Name': contact.identity_name,
          'Status': contact.status,
          'Quality Index': contact.quality_index,
          'Last Engagement': contact.last_engagement_at,
          'Account Created': contact.created_at,
          'Last Updated': contact.updated_at
        };
        Object.entries(contactFields).forEach(([key, value]) => {
          if (value !== null && value !== undefined) {
            csvRows.push(esc(key) + ',' + esc(value));
          }
        });
      }
      csvRows.push('');
      
      // LIST SUBSCRIPTIONS
      csvRows.push('LIST SUBSCRIPTIONS');
      csvRows.push('List Name,Subscribed Date,Status');
      if (lists.rows.length) {
        lists.rows.forEach(list => {
          csvRows.push(esc(list.name) + ',' + esc(list.added_at) + ',' + esc(list.status || 'active'));
        });
      } else {
        csvRows.push('No list subscriptions');
      }
      csvRows.push('');
      
      // CAMPAIGNS RECEIVED
      csvRows.push('CAMPAIGNS RECEIVED');
      csvRows.push('Campaign Name,Status,Date');
      if (campaigns.rows.length) {
        campaigns.rows.forEach(camp => {
          csvRows.push(esc(camp.name) + ',' + esc(camp.status) + ',' + esc(camp.sent_at));
        });
      } else {
        csvRows.push('No campaigns received');
      }
      csvRows.push('');
      
      // EMAIL INTERACTIONS
      csvRows.push('EMAIL INTERACTIONS');
      csvRows.push('Event Type,Date,Campaign ID');
      if (tracking.rows.length) {
        tracking.rows.forEach(evt => {
          csvRows.push(esc(evt.type) + ',' + esc(evt.occurred_at) + ',' + esc(evt.campaign_id || ''));
        });
      } else {
        csvRows.push('No email interactions');
      }
      csvRows.push('');
      
      // UNSUBSCRIBE HISTORY
      csvRows.push('UNSUBSCRIBE HISTORY');
      csvRows.push('Date,Campaign ID,List ID');
      if (unsubscribeEvents.rows.length) {
        unsubscribeEvents.rows.forEach(evt => {
          csvRows.push(esc(evt.created_at) + ',' + esc(evt.campaign_id || '') + ',' + esc(evt.list_id || ''));
        });
      } else {
        csvRows.push('No unsubscribe events');
      }
      csvRows.push('');
      
      // SUPPRESSION STATUS
      csvRows.push('SUPPRESSION STATUS');
      csvRows.push('Status,Reason,Source,Landing Variant,Suppressed Date');
      if (suppression.rows[0]) {
        const s = suppression.rows[0];
        csvRows.push('Suppressed,' + esc(s.reason || '') + ',' + esc(s.source || '') + ',' + esc(s.landing_variant || '') + ',' + esc(s.created_at || ''));
      } else {
        csvRows.push('Active,,,');
      }
      
      fileContent = csvRows.join('\n');
      contentType = 'text/csv; charset=utf-8';
      filename = `gdpr-export-${email}-${dateStr}.csv`;
    } else {
      // JSON format - filter to only personal data
      const filteredData = {
        contact: {},
        lists: lists.rows.map(l => ({ name: l.name, subscribed_at: l.added_at || l.created_at, status: l.status })),
        campaigns: campaigns.rows.map(c => ({ name: c.name, status: c.status, date: c.sent_at })),
        interactions: tracking.rows.map(e => ({ type: e.type || e.event_type, date: e.occurred_at, campaign_id: e.campaign_id })),
        unsubscribes: unsubscribeEvents.rows.map(e => ({ date: e.created_at, campaign_id: e.campaign_id, list_id: e.list_id })),
        suppression_status: suppression.rows[0] ? {
          status: 'suppressed',
          reason: suppression.rows[0].reason,
          source: suppression.rows[0].source,
          landing_variant: suppression.rows[0].landing_variant,
          date: suppression.rows[0].created_at
        } : { status: 'active' },
        exported_at: exportData.exported_at
      };
      
      // Only include personal data fields from contact
      if (contact) {
        const personalFields = ['email', 'name', 'phone', 'identity_type', 'identity_name', 'status', 'quality_index', 'last_engagement_at', 'created_at', 'updated_at'];
        personalFields.forEach(field => {
          if (contact[field] !== null && contact[field] !== undefined) {
            filteredData.contact[field] = contact[field];
          }
        });
      }
      
      fileContent = JSON.stringify(filteredData, null, 2);
      contentType = 'application/json; charset=utf-8';
      filename = `gdpr-export-${email}-${dateStr}.json`;
    }
    
    // Send via Backend API's internal system email endpoint
    const apiUrl = process.env.BACKEND_API_URL || 'http://10.66.66.4:3001';
    const token = process.env.COMM_INTERNAL_TOKEN || '';
    
    const response = await fetch(`${apiUrl}/api/internal/system-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        emailType: 'custom_admin',
        to: email,
        templateVariables: {
          custom_subject: `Your GDPR Data Export - ${filename}`,
          custom_message: `<p>Your personal data export (${format.toUpperCase()} format) is attached.</p><p>This export includes all your personal data as required by GDPR Article 20 (Right to Data Portability).</p>`
        },
        attachment_filename: filename,
        attachment_content: Buffer.from(fileContent).toString('base64'),
        attachment_content_type: contentType
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend API error: ${response.status} - ${errorText}`);
    }
    
    res.json({
      success: true,
      message: `GDPR data export has been emailed to ${email}`,
      data: { email, format, filename, queued_at: new Date().toISOString() }
    });
  } catch (e) {
    console.error('GDPR export error:', e);
    res.status(500).json({ success: false, error: 'Failed to export GDPR data: ' + e.message });
  }
});

export default router;
