// Unsubscribe Events & Analytics Routes
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

// Get unsubscribe events
router.get('/unsubscribe-events', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const days = parseInt(req.query.days) || 30;
    const campaignId = req.query.campaign_id || null;
    const email = req.query.email || '';
    
    const offset = (page - 1) * limit;
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    
    let queryText = `
      SELECT 
        ue.id,
        ue.email,
        ue.campaign_id,
        c.name as campaign_name,
        ue.created_at,
        ue.source
      FROM unsubscribe_events ue
      LEFT JOIN campaigns c ON ue.campaign_id = c.id
      WHERE ue.tenant_id = $1
        AND ue.created_at >= $2
    `;
    
    const params = [req.tenantId, sinceDate];
    let paramIndex = 3;
    
    if (campaignId) {
      queryText += ` AND ue.campaign_id = $${paramIndex}`;
      params.push(campaignId);
      paramIndex++;
    }
    
    if (email) {
      queryText += ` AND ue.email ILIKE $${paramIndex}`;
      params.push(`%${email}%`);
      paramIndex++;
    }
    
    queryText += ` ORDER BY ue.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const events = await query(queryText, params);
    
    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM unsubscribe_events ue
      WHERE ue.tenant_id = $1 AND ue.created_at >= $2
    `;
    const countParams = [req.tenantId, sinceDate];
    if (campaignId) {
      countQuery += ' AND ue.campaign_id = $3';
      countParams.push(campaignId);
    }
    if (email) {
      countQuery += ` AND ue.email ILIKE $${campaignId ? 4 : 3}`;
      countParams.push(`%${email}%`);
    }
    
    const countResult = await query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);
    
    res.json({
      success: true,
      data: {
        events: events.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (e) {
    console.error('Get unsubscribe events error:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch unsubscribe events' });
  }
});

// Get unsubscribe analytics
router.get('/unsubscribe-analytics', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const campaignId = req.query.campaign_id || null;
    
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    
    // Total unsubscribes
    let totalQuery = `
      SELECT COUNT(*) as total
      FROM unsubscribe_events
      WHERE tenant_id = $1 AND created_at >= $2
    `;
    const totalParams = [req.tenantId, sinceDate];
    if (campaignId) {
      totalQuery += ' AND campaign_id = $3';
      totalParams.push(campaignId);
    }
    const totalResult = await query(totalQuery, totalParams);
    const total = parseInt(totalResult.rows[0].total);
    
    // Last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    let last7Query = `
      SELECT COUNT(*) as count
      FROM unsubscribe_events
      WHERE tenant_id = $1 AND created_at >= $2
    `;
    const last7Params = [req.tenantId, sevenDaysAgo];
    if (campaignId) {
      last7Query += ' AND campaign_id = $3';
      last7Params.push(campaignId);
    }
    const last7Result = await query(last7Query, last7Params);
    const last7Days = parseInt(last7Result.rows[0].count);
    
    // Unsubscribe rate (requires campaign sends count)
    let rate = 0;
    if (campaignId) {
      const sendsQuery = `
        SELECT COUNT(*) as total_sent
        FROM campaign_recipients
        WHERE campaign_id = $1 AND tenant_id = $2
      `;
      const sendsResult = await query(sendsQuery, [campaignId, req.tenantId]);
      const totalSent = parseInt(sendsResult.rows[0].total_sent);
      if (totalSent > 0) {
        rate = (total / totalSent) * 100;
      }
    }
    
    // Recent events (last 10)
    let recentQuery = `
      SELECT 
        ue.email,
        c.name as campaign_name,
        ue.created_at as timestamp
      FROM unsubscribe_events ue
      LEFT JOIN campaigns c ON ue.campaign_id = c.id
      WHERE ue.tenant_id = $1
    `;
    const recentParams = [req.tenantId];
    if (campaignId) {
      recentQuery += ' AND ue.campaign_id = $2';
      recentParams.push(campaignId);
    }
    recentQuery += ' ORDER BY ue.created_at DESC LIMIT 10';
    const recentResult = await query(recentQuery, recentParams);
    
    res.json({
      success: true,
      data: {
        total,
        rate: parseFloat(rate.toFixed(2)),
        last_7_days: last7Days,
        recent: recentResult.rows
      }
    });
  } catch (e) {
    console.error('Get unsubscribe analytics error:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch unsubscribe analytics' });
  }
});

// Get unsubscribe trends
router.get('/unsubscribe-trends', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const interval = req.query.interval || 'day';
    const campaignId = req.query.campaign_id || null;
    
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    
    // Determine date truncation based on interval
    let dateTrunc = 'day';
    if (interval === 'hour') dateTrunc = 'hour';
    else if (interval === 'week') dateTrunc = 'week';
    
    let queryText = `
      SELECT 
        DATE_TRUNC($1, created_at) as date,
        COUNT(*) as count
      FROM unsubscribe_events
      WHERE tenant_id = $2
        AND created_at >= $3
    `;
    
    const params = [dateTrunc, req.tenantId, sinceDate];
    if (campaignId) {
      queryText += ' AND campaign_id = $4';
      params.push(campaignId);
    }
    
    queryText += ' GROUP BY DATE_TRUNC($1, created_at) ORDER BY date ASC';
    
    const result = await query(queryText, params);
    
    const dates = result.rows.map(r => r.date.toISOString());
    const counts = result.rows.map(r => parseInt(r.count));
    
    res.json({
      success: true,
      data: {
        dates,
        counts
      }
    });
  } catch (e) {
    console.error('Get unsubscribe trends error:', e);
    res.status(500).json({ success: false, error: 'Failed to fetch unsubscribe trends' });
  }
});

export default router;
