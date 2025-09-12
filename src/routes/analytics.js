import express from 'express';
import { query } from '../db.js';
import { requireEntitledTenant } from '../middleware/entitlement.js';
import pino from 'pino';

const router = express.Router();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Helper to get tenant from header (consistent with other route files)
function requireTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
  req.tenantId = tenantId;
  next();
}

/**
 * Campaign Analytics API - Customer-facing performance data
 */

// GET /api/campaigns/:id/analytics - Campaign performance summary
router.get('/campaigns/:id/analytics', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { id: campaignId } = req.params;
    const { days = 30 } = req.query;
    const tenantId = req.tenantId;

    // Verify campaign belongs to tenant
    const campaignCheck = await query(
      'SELECT id, name FROM campaigns WHERE id = $1 AND tenant_id = $2',
      [campaignId, tenantId]
    );

    if (campaignCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found'
      });
    }

    const campaign = campaignCheck.rows[0];

    // Get email events summary
    const eventsQuery = `
      SELECT 
        type,
        COUNT(*) as count,
        COUNT(DISTINCT contact_id) as unique_contacts
      FROM email_events 
      WHERE campaign_id = $1 
        AND tenant_id = $2 
        AND occurred_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY type
      ORDER BY type
    `;

    const eventsResult = await query(eventsQuery, [campaignId, tenantId]);
    
    // Transform events into summary
    const events = {};
    eventsResult.rows.forEach(row => {
      events[row.type] = {
        total: parseInt(row.count),
        unique: parseInt(row.unique_contacts)
      };
    });

    // Calculate rates
    const sent = events.sent?.total || 0;
    const delivered = events.delivered?.total || 0;
    const clicked = events.clicked?.total || 0;
    const bounced = events.bounced?.total || 0;
    const complained = events.complained?.total || 0;

    const deliveryRate = sent > 0 ? Math.round((delivered / sent) * 100) : 0;
    const clickRate = delivered > 0 ? Math.round((clicked / delivered) * 100) : 0;
    const bounceRate = sent > 0 ? Math.round((bounced / sent) * 100) : 0;

    // Get link performance from artifacts metadata
    const linkPerformanceQuery = `
      SELECT 
        meta->'linkMap' as link_map
      FROM comm_campaign_artifacts 
      WHERE campaign_id = $1 
      ORDER BY version DESC 
      LIMIT 1
    `;
    
    const linkResult = await query(linkPerformanceQuery, [campaignId]);
    const linkMap = linkResult.rows[0]?.link_map || [];

    // Get click details for each link
    const linkClicksQuery = `
      SELECT 
        (payload->>'linkIndex')::int as link_index,
        payload->>'originalUrl' as original_url,
        COUNT(*) as clicks,
        COUNT(DISTINCT contact_id) as unique_clickers
      FROM email_events 
      WHERE campaign_id = $1 
        AND tenant_id = $2 
        AND type = 'clicked'
        AND payload->>'linkIndex' IS NOT NULL
      GROUP BY payload->>'linkIndex', payload->>'originalUrl'
      ORDER BY clicks DESC
    `;

    const clicksResult = await query(linkClicksQuery, [campaignId, tenantId]);
    
    // Enhance link map with click data
    const linkPerformance = linkMap.map(link => {
      const clickData = clicksResult.rows.find(c => c.link_index === link.index);
      return {
        ...link,
        clicks: clickData?.clicks || 0,
        unique_clickers: clickData?.unique_clickers || 0,
        click_rate: delivered > 0 ? Math.round(((clickData?.clicks || 0) / delivered) * 100) : 0
      };
    });

    res.json({
      success: true,
      data: {
        campaign: {
          id: campaignId,
          name: campaign.name
        },
        summary: {
          sent,
          delivered,
          clicked: clicked,
          bounced,
          complained,
          delivery_rate: deliveryRate,
          click_rate: clickRate,
          bounce_rate: bounceRate,
          unique_clickers: events.clicked?.unique || 0
        },
        events,
        link_performance: linkPerformance,
        period_days: parseInt(days)
      }
    });

  } catch (error) {
    logger.error({ 
      tenantId: req.tenantId, 
      campaignId: req.params.id, 
      error: error.message 
    }, 'Failed to fetch campaign analytics');
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch campaign analytics',
      details: error.message
    });
  }
});

// GET /api/campaigns/:id/clicks - Detailed click data for campaign
router.get('/campaigns/:id/clicks', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { id: campaignId } = req.params;
    const { limit = 50, offset = 0, link_index } = req.query;
    const tenantId = req.tenantId;

    // Build WHERE conditions
    const conditions = ['ee.campaign_id = $1', 'ee.tenant_id = $2', 'ee.type = $3'];
    const params = [campaignId, tenantId, 'clicked'];
    let paramCount = 3;

    if (link_index !== undefined) {
      paramCount++;
      conditions.push(`(ee.payload->>'linkIndex')::int = $${paramCount}`);
      params.push(parseInt(link_index));
    }

    // Add pagination
    paramCount++;
    const limitParam = paramCount;
    params.push(parseInt(limit));
    
    paramCount++;
    const offsetParam = paramCount;
    params.push(parseInt(offset));

    const whereClause = conditions.join(' AND ');

    // Get detailed click data
    const clicksQuery = `
      SELECT 
        ee.id,
        ee.occurred_at,
        ee.payload->>'originalUrl' as original_url,
        ee.payload->>'linkIndex' as link_index,
        ee.payload->>'userAgent' as user_agent,
        ee.payload->>'ip' as ip_address,
        c.email,
        c.name as contact_name,
        rs.computed_status as recipient_status
      FROM email_events ee
      JOIN contacts c ON c.id = ee.contact_id
      LEFT JOIN recipient_status rs ON rs.id = c.id
      WHERE ${whereClause}
      ORDER BY ee.occurred_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const result = await query(clicksQuery, params);

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM email_events ee
      WHERE ${conditions.join(' AND ')}
    `;
    
    const countResult = await query(countQuery, params.slice(0, -2));
    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      data: {
        clicks: result.rows.map(row => ({
          id: row.id,
          occurred_at: row.occurred_at,
          link: {
            index: parseInt(row.link_index),
            url: row.original_url
          },
          recipient: {
            email: row.email,
            name: row.contact_name,
            status: row.recipient_status
          },
          user_agent: row.user_agent,
          ip_address: row.ip_address
        })),
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: (parseInt(offset) + parseInt(limit)) < total
        }
      }
    });

  } catch (error) {
    logger.error({ 
      tenantId: req.tenantId, 
      campaignId: req.params.id, 
      error: error.message 
    }, 'Failed to fetch campaign clicks');
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch campaign clicks',
      details: error.message
    });
  }
});

// GET /api/analytics/overview - Tenant-wide analytics overview
router.get('/analytics/overview', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const tenantId = req.tenantId;

    // Get overall stats for the tenant
    const overviewQuery = `
      SELECT 
        type,
        COUNT(*) as total_events,
        COUNT(DISTINCT campaign_id) as campaigns_with_events,
        COUNT(DISTINCT contact_id) as unique_recipients
      FROM email_events 
      WHERE tenant_id = $1 
        AND occurred_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY type
      ORDER BY type
    `;

    const result = await query(overviewQuery, [tenantId]);
    
    const overview = {};
    result.rows.forEach(row => {
      overview[row.type] = {
        total_events: parseInt(row.total_events),
        campaigns: parseInt(row.campaigns_with_events),
        unique_recipients: parseInt(row.unique_recipients)
      };
    });

    // Get top performing campaigns
    const topCampaignsQuery = `
      SELECT 
        c.id,
        c.name,
        COUNT(CASE WHEN ee.type = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN ee.type = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN ee.type = 'clicked' THEN 1 END) as clicked,
        COUNT(DISTINCT CASE WHEN ee.type = 'clicked' THEN ee.contact_id END) as unique_clickers
      FROM campaigns c
      LEFT JOIN email_events ee ON ee.campaign_id = c.id 
        AND ee.occurred_at >= NOW() - INTERVAL '${parseInt(days)} days'
      WHERE c.tenant_id = $1
      GROUP BY c.id, c.name
      ORDER BY clicked DESC, delivered DESC
      LIMIT 10
    `;

    const topCampaignsResult = await query(topCampaignsQuery, [tenantId]);

    res.json({
      success: true,
      data: {
        overview,
        top_campaigns: topCampaignsResult.rows.map(row => ({
          id: row.id,
          name: row.name,
          sent: parseInt(row.sent) || 0,
          delivered: parseInt(row.delivered) || 0,
          clicked: parseInt(row.clicked) || 0,
          unique_clickers: parseInt(row.unique_clickers) || 0,
          click_rate: parseInt(row.delivered) > 0 ? 
            Math.round((parseInt(row.clicked) / parseInt(row.delivered)) * 100) : 0
        })),
        period_days: parseInt(days)
      }
    });

  } catch (error) {
    logger.error({ 
      tenantId: req.tenantId, 
      error: error.message 
    }, 'Failed to fetch analytics overview');
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch analytics overview',
      details: error.message
    });
  }
});

export default router;
