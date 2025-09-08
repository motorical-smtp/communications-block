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
    const r = await query('SELECT id, status FROM tenants WHERE id=$1', [tenantId]);
    if (r.rowCount === 0) return res.status(403).json({ success: false, error: 'Tenant not provisioned' });
    if (r.rows[0].status !== 'active') return res.status(403).json({ success: false, error: 'Tenant not active' });
    return next();
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Entitlement check failed' });
  }
}


