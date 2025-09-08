// Suppression List Management Routes
// Customer-scoped suppression list management for Communications Block

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

// ================== SUPPRESSION LIST MANAGEMENT ENDPOINTS ==================

// Get all suppressions for the customer account
router.get('/', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    // Get customer's motorical_account_id
    const accountResult = await query(
      `SELECT motorical_account_id FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    
    if (accountResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }
    
    const motoricalAccountId = accountResult.rows[0].motorical_account_id;

    // Build search condition
    const searchCondition = search ? 
      `AND (s.email ILIKE $3 OR s.reason ILIKE $3 OR s.source ILIKE $3)` : '';
    const searchParams = search ? [`%${search}%`] : [];

    // Get suppressions with contact status
    const suppressions = await query(`
      SELECT 
        s.id,
        s.email,
        s.reason,
        s.source,
        s.landing_variant,
        s.created_at,
        c.id as contact_id,
        c.status as contact_status,
        c.name as contact_name,
        c.identity_type as contact_type
      FROM suppressions s
      LEFT JOIN contacts c ON c.email = s.email AND c.tenant_id = $1
      WHERE s.motorical_account_id = $2 ${searchCondition}
      ORDER BY s.created_at DESC
      LIMIT $${3 + searchParams.length} OFFSET $${4 + searchParams.length}
    `, [req.tenantId, motoricalAccountId, ...searchParams, limit, offset]);

    // Get total count
    const countResult = await query(`
      SELECT COUNT(*) as total
      FROM suppressions s
      WHERE s.motorical_account_id = $1 ${searchCondition}
    `, [motoricalAccountId, ...searchParams]);

    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        suppressions: suppressions.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1
        }
      }
    });
  } catch (e) {
    console.error('Get suppressions error:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch suppressions' });
  }
});

// Add email to suppression list
router.post('/', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { email, reason = 'manual', source = 'admin' } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email address required' });
    }

    // Get customer's motorical_account_id
    const accountResult = await query(
      `SELECT motorical_account_id FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    
    if (accountResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }
    
    const motoricalAccountId = accountResult.rows[0].motorical_account_id;

    // Add to suppressions
    await query(`
      INSERT INTO suppressions (motorical_account_id, tenant_id, email, reason, source, landing_variant)
      VALUES ($1, $2, $3, $4, $5, 'admin')
      ON CONFLICT (motorical_account_id, email) DO NOTHING
    `, [motoricalAccountId, req.tenantId, email.toLowerCase(), reason, source]);

    // Update any existing contacts
    const contactUpdate = await query(`
      UPDATE contacts 
      SET status = 'unsubscribed', updated_at = NOW()
      WHERE email = $1 AND tenant_id = $2 AND status != 'unsubscribed'
    `, [email.toLowerCase(), req.tenantId]);

    // Note: Contact status updated but no event logging to email_events 
    // since this table is for campaign events, not administrative actions

    res.json({ 
      success: true, 
      message: 'Email added to suppression list',
      data: { email, contacts_updated: contactUpdate.rowCount }
    });
  } catch (e) {
    console.error('Add suppression error:', e);
    res.status(500).json({ success: false, error: 'Failed to add suppression' });
  }
});

// Remove email from suppression list (resubscribe)
router.delete('/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const suppressionId = req.params.id;

    // Get customer's motorical_account_id
    const accountResult = await query(
      `SELECT motorical_account_id FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    
    if (accountResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }
    
    const motoricalAccountId = accountResult.rows[0].motorical_account_id;

    // Get suppression details before deletion
    const suppressionResult = await query(`
      SELECT email FROM suppressions 
      WHERE id = $1 AND motorical_account_id = $2
    `, [suppressionId, motoricalAccountId]);

    if (suppressionResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Suppression not found' });
    }

    const email = suppressionResult.rows[0].email;

    // Remove from suppressions
    await query(`
      DELETE FROM suppressions 
      WHERE id = $1 AND motorical_account_id = $2
    `, [suppressionId, motoricalAccountId]);

    // Update any existing contacts
    const contactUpdate = await query(`
      UPDATE contacts 
      SET status = 'active', updated_at = NOW()
      WHERE email = $1 AND tenant_id = $2 AND status = 'unsubscribed'
    `, [email, req.tenantId]);

    // Note: Contact status updated but no event logging to email_events 
    // since this table is for campaign events, not administrative actions

    res.json({ 
      success: true, 
      message: 'Email removed from suppression list',
      data: { email, contacts_updated: contactUpdate.rowCount }
    });
  } catch (e) {
    console.error('Remove suppression error:', e);
    res.status(500).json({ success: false, error: 'Failed to remove suppression' });
  }
});

// Bulk import suppressions
router.post('/bulk', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { emails, reason = 'bulk_import', source = 'admin' } = req.body;

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ success: false, error: 'Array of emails required' });
    }

    if (emails.length > 1000) {
      return res.status(400).json({ success: false, error: 'Maximum 1000 emails per bulk import' });
    }

    // Get customer's motorical_account_id
    const accountResult = await query(
      `SELECT motorical_account_id FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    
    if (accountResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }
    
    const motoricalAccountId = accountResult.rows[0].motorical_account_id;

    let processed = 0;
    let added = 0;
    let skipped = 0;
    let contactsUpdated = 0;
    const errors = [];

    for (const email of emails) {
      try {
        processed++;
        
        if (!email || !email.includes('@')) {
          errors.push({ email, error: 'Invalid email format' });
          continue;
        }

        const cleanEmail = email.toLowerCase().trim();

        // Add to suppressions
        const insertResult = await query(`
          INSERT INTO suppressions (motorical_account_id, tenant_id, email, reason, source, landing_variant)
          VALUES ($1, $2, $3, $4, $5, 'admin')
          ON CONFLICT (motorical_account_id, email) DO NOTHING
          RETURNING id
        `, [motoricalAccountId, req.tenantId, cleanEmail, reason, source]);

        if (insertResult.rowCount > 0) {
          added++;

          // Update any existing contacts
          const contactUpdate = await query(`
            UPDATE contacts 
            SET status = 'unsubscribed', updated_at = NOW()
            WHERE email = $1 AND tenant_id = $2 AND status != 'unsubscribed'
          `, [cleanEmail, req.tenantId]);

          contactsUpdated += contactUpdate.rowCount;
        } else {
          skipped++;
        }
      } catch (err) {
        errors.push({ email, error: err.message });
      }
    }

    res.json({
      success: true,
      message: 'Bulk suppression import completed',
      data: {
        processed,
        added,
        skipped,
        contactsUpdated,
        errors: errors.slice(0, 10), // Limit error samples
        totalErrors: errors.length
      }
    });
  } catch (e) {
    console.error('Bulk suppression import error:', e);
    res.status(500).json({ success: false, error: 'Bulk import failed' });
  }
});

// Get suppression statistics
router.get('/stats', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    // Get customer's motorical_account_id
    const accountResult = await query(
      `SELECT motorical_account_id FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    
    if (accountResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }
    
    const motoricalAccountId = accountResult.rows[0].motorical_account_id;

    // Get comprehensive stats
    const stats = await query(`
      SELECT 
        COUNT(*) as total_suppressions,
        COUNT(CASE WHEN reason = 'unsubscribe' THEN 1 END) as unsubscribed_count,
        COUNT(CASE WHEN reason = 'bounce' THEN 1 END) as bounced_count,
        COUNT(CASE WHEN reason = 'complaint' THEN 1 END) as complaint_count,
        COUNT(CASE WHEN reason = 'manual' THEN 1 END) as manual_count,
        COUNT(CASE WHEN source = 'link' THEN 1 END) as link_unsubscribes,
        COUNT(CASE WHEN source = 'admin' THEN 1 END) as admin_suppressions,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as recent_suppressions,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as monthly_suppressions
      FROM suppressions 
      WHERE motorical_account_id = $1
    `, [motoricalAccountId]);

    // Get contact status breakdown
    const contactStats = await query(`
      SELECT 
        COUNT(*) as total_contacts,
        COUNT(CASE WHEN status = 'unsubscribed' THEN 1 END) as unsubscribed_contacts,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_contacts
      FROM contacts 
      WHERE tenant_id = $1
    `, [req.tenantId]);

    const suppressionData = stats.rows[0] || {};
    const contactData = contactStats.rows[0] || {};

    res.json({
      success: true,
      data: {
        suppressions: {
          total: parseInt(suppressionData.total_suppressions) || 0,
          by_reason: {
            unsubscribe: parseInt(suppressionData.unsubscribed_count) || 0,
            bounce: parseInt(suppressionData.bounced_count) || 0,
            complaint: parseInt(suppressionData.complaint_count) || 0,
            manual: parseInt(suppressionData.manual_count) || 0
          },
          by_source: {
            link: parseInt(suppressionData.link_unsubscribes) || 0,
            admin: parseInt(suppressionData.admin_suppressions) || 0
          },
          recent: {
            last_7_days: parseInt(suppressionData.recent_suppressions) || 0,
            last_30_days: parseInt(suppressionData.monthly_suppressions) || 0
          }
        },
        contacts: {
          total: parseInt(contactData.total_contacts) || 0,
          active: parseInt(contactData.active_contacts) || 0,
          unsubscribed: parseInt(contactData.unsubscribed_contacts) || 0
        }
      }
    });
  } catch (e) {
    console.error('Suppression stats error:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch suppression statistics' });
  }
});

export default router;
