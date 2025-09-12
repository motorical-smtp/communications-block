import { query } from '../db.js';

export async function getNextVersionForCampaign(campaignId) {
  const r = await query('SELECT COALESCE(MAX(version),0)+1 AS next FROM comm_campaign_artifacts WHERE campaign_id=$1', [campaignId]);
  return r.rows?.[0]?.next || 1;
}

export async function getLatestArtifact(campaignId, tenantId) {
  const r = await query(
    `SELECT id, campaign_id, version, subject, html_compiled, text_compiled, meta, created_at
     FROM comm_campaign_artifacts
     WHERE campaign_id=$1 AND tenant_id=$2
     ORDER BY version DESC
     LIMIT 1`,
    [campaignId, tenantId]
  );
  return r.rows?.[0] || null;
}

export async function getLatestAudienceSnapshot(campaignId, tenantId) {
  const r = await query(
    `SELECT id, campaign_id, version, total_recipients, included_lists, deduped_by, filters, created_at
     FROM comm_audience_snapshots
     WHERE campaign_id=$1 AND tenant_id=$2
     ORDER BY version DESC
     LIMIT 1`,
    [campaignId, tenantId]
  );
  return r.rows?.[0] || null;
}


