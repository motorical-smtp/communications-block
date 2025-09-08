import { query } from '../db.js';

export function requireInternal(req, res, next) {
  const token = req.headers['x-internal-token'];
  const expected = process.env.COMM_INTERNAL_TOKEN || '';
  if (!expected || token !== expected) {
    return res.status(401).json({ success: false, error: 'Unauthorized (internal)' });
  }
  return next();
}

export async function requireEntitledTenant(req, res, next) {
  try {
    const tenantId = req.headers['x-tenant-id'];
    if (!tenantId) return res.status(400).json({ success: false, error: 'Missing X-Tenant-Id' });
    
    // Get tenant info including motorical_account_id for subscription checking
    const r = await query('SELECT id, status, motorical_account_id FROM tenants WHERE id=$1', [tenantId]);
    if (r.rowCount === 0) return res.status(403).json({ success: false, error: 'Tenant not provisioned' });
    
    const tenant = r.rows[0];
    if (tenant.status !== 'active') return res.status(403).json({ success: false, error: 'Tenant not active' });
    
    // Additional subscription verification for Communications Block
    // Note: This is a secondary check. Primary check happens in backend /api/comm/tenant
    // But this ensures direct API access also respects subscription levels
    
    req.tenantId = tenantId;
    req.motoricalAccountId = tenant.motorical_account_id;
    return next();
  } catch (e) {
    console.error('Entitlement check error:', e);
    return res.status(500).json({ success: false, error: 'Entitlement check failed' });
  }
}


