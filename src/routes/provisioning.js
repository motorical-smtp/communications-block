import express from 'express';
import { query } from '../db.js';
import { requireInternal } from '../middleware/entitlement.js';

const router = express.Router();

// Called by Motorical backend upon add-on activation for any of the three hosting SKUs
router.post('/provision/tenant', requireInternal, async (req, res) => {
  try {
    const { motorical_account_id, status = 'active' } = req.body || {};
    if (!motorical_account_id) return res.status(400).json({ success: false, error: 'motorical_account_id required' });
    // upsert tenant by motorical_account_id
    const r = await query('SELECT id FROM tenants WHERE motorical_account_id=$1', [motorical_account_id]);
    let tenantId;
    if (r.rowCount === 0) {
      const ins = await query('INSERT INTO tenants (motorical_account_id, status) VALUES ($1,$2) RETURNING id', [motorical_account_id, status]);
      tenantId = ins.rows[0].id;
    } else {
      tenantId = r.rows[0].id;
      await query('UPDATE tenants SET status=$2 WHERE motorical_account_id=$1', [motorical_account_id, status]);
    }
    res.json({ success: true, data: { tenant_id: tenantId }, message: 'Tenant provisioned' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Provisioning failed' });
  }
});

// Called by Motorical backend upon add-on cancellation for any of the three hosting SKUs
router.post('/deprovision/tenant', requireInternal, async (req, res) => {
  try {
    const { motorical_account_id } = req.body || {};
    if (!motorical_account_id) return res.status(400).json({ success: false, error: 'motorical_account_id required' });
    await query('UPDATE tenants SET status=\'paused\' WHERE motorical_account_id=$1', [motorical_account_id]);
    // Optionally: pause all campaigns for this tenant
    await query("UPDATE campaigns SET status='paused' WHERE tenant_id IN (SELECT id FROM tenants WHERE motorical_account_id=$1)", [motorical_account_id]);
    res.json({ success: true, message: 'Tenant deprovisioned (paused)' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Deprovisioning failed' });
  }
});

export default router;


