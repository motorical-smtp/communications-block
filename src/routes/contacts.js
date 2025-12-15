// Contact Management Routes
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

// Delete a contact (GDPR compliance)
router.delete('/contacts/:id', requireTenant, requireEntitledTenant, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify contact belongs to tenant
    const contactCheck = await query(
      'SELECT id, email FROM contacts WHERE id = $1 AND tenant_id = $2',
      [id, req.tenantId]
    );
    
    if (contactCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    
    const email = contactCheck.rows[0].email;
    
    // Begin transaction
    await query('BEGIN');
    
    try {
      // Delete list memberships
      await query('DELETE FROM list_contacts WHERE contact_id = $1', [id]);
      
      // Anonymize campaign recipient records (GDPR compliance - keep records but remove PII)
      await query(
        'UPDATE email_events SET contact_id = NULL WHERE contact_id = $1',
        [id]
      );
      
      // Anonymize tracking events (GDPR compliance)
      await query(
        'UPDATE email_events SET contact_id = NULL WHERE contact_id = $1',
        [id]
      );
      
      // Delete contact record
      await query('DELETE FROM contacts WHERE id = $1', [id]);
      
      await query('COMMIT');
      
      res.json({
        success: true,
        message: 'Contact deleted successfully'
      });
    } catch (error) {
      await query('ROLLBACK');
      throw error;
    }
  } catch (e) {
    console.error('Delete contact error:', e);
    res.status(500).json({ success: false, error: 'Failed to delete contact' });
  }
});

export default router;
