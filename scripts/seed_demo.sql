-- Demo data seeding for compile-before-send e2e testing
-- Creates: tenant, template, list, contact, campaign with HTML/merge tags
-- Usage: sudo -u postgres psql -d communications_db -f scripts/seed_demo.sql

DO $$
DECLARE 
  t UUID; 
  tpl UUID; 
  l UUID; 
  c UUID; 
  camp UUID;
BEGIN
  -- Ensure a tenant exists
  SELECT id INTO t FROM tenants ORDER BY created_at LIMIT 1;
  IF t IS NULL THEN 
    INSERT INTO tenants(motorical_account_id) VALUES (gen_random_uuid()) RETURNING id INTO t; 
    RAISE NOTICE 'Created tenant: %', t;
  ELSE
    RAISE NOTICE 'Using existing tenant: %', t;
  END IF;

  -- Ensure a template exists with HTML/merge tags
  SELECT id INTO tpl FROM templates WHERE tenant_id=t LIMIT 1;
  IF tpl IS NULL THEN
    INSERT INTO templates(tenant_id, name, subject, type, body_html, body_text)
    VALUES (
      t,
      'Demo Compile Template',
      'Hello {{name}} - Test Campaign',
      'html',
      $html$<html><head><title>{{name}} - Demo Email</title></head><body><h1>Hi {{name}}!</h1><p>This is a demo email for <strong>{{identity_name}}</strong>.</p><p>Visit our <a href="https://example.com/products?utm_source=email&utm_campaign=demo">products page</a>.</p><p>Questions? <a href="mailto:support@example.com">Contact support</a>.</p><p><small>Don't want these emails? <a href="{{unsubscribe_url}}">Unsubscribe here</a>.</small></p></body></html>$html$,
      $text$Hi {{name}}!

This is a demo email for {{identity_name}}.

Visit our products page: https://example.com/products?utm_source=email&utm_campaign=demo

Questions? Contact support: support@example.com

Don't want these emails? Unsubscribe: {{unsubscribe_url}}$text$
    ) RETURNING id INTO tpl;
    RAISE NOTICE 'Created template: %', tpl;
  ELSE
    RAISE NOTICE 'Using existing template: %', tpl;
  END IF;

  -- Ensure a list exists
  SELECT id INTO l FROM lists WHERE tenant_id=t LIMIT 1;
  IF l IS NULL THEN 
    INSERT INTO lists(tenant_id, name, description) 
    VALUES (t, 'Demo Compile List', 'Test list for compile-before-send validation') 
    RETURNING id INTO l;
    RAISE NOTICE 'Created list: %', l;
  ELSE
    RAISE NOTICE 'Using existing list: %', l;
  END IF;

  -- Ensure a contact exists
  SELECT id INTO c FROM contacts WHERE tenant_id=t LIMIT 1;
  IF c IS NULL THEN 
    INSERT INTO contacts(tenant_id, email, name, identity_name, status)
    VALUES (t, 'demo@example.com', 'Demo Recipient', 'ACME Corp', 'active') 
    RETURNING id INTO c;
    RAISE NOTICE 'Created contact: %', c;
  ELSE
    RAISE NOTICE 'Using existing contact: %', c;
  END IF;

  -- Link contact to list (idempotent)
  INSERT INTO list_contacts(list_id, contact_id, status) 
  VALUES (l, c, 'active') 
  ON CONFLICT (list_id, contact_id) DO NOTHING;

  -- Create a new campaign for testing
  INSERT INTO campaigns(tenant_id, name, template_id, motor_block_id, status)
  VALUES (t, 'Demo Compile Campaign', tpl, gen_random_uuid(), 'draft') 
  RETURNING id INTO camp;
  RAISE NOTICE 'Created campaign: %', camp;

  -- Link campaign to list (idempotent)
  INSERT INTO campaign_lists(campaign_id, list_id) 
  VALUES (camp, l) 
  ON CONFLICT (campaign_id, list_id) DO NOTHING;

  -- Output test identifiers
  RAISE NOTICE '=== SEED COMPLETE ===';
  RAISE NOTICE 'TENANT_ID=%', t;
  RAISE NOTICE 'CAMPAIGN_ID=%', camp;
  RAISE NOTICE 'Next steps:';
  RAISE NOTICE '1) curl -X POST http://127.0.0.1:3011/api/campaigns/%/compile -H "X-Tenant-Id: %" -H "Content-Type: application/json"', camp, t;
  RAISE NOTICE '2) curl http://127.0.0.1:3011/api/campaigns/% -H "X-Tenant-Id: %"', camp, t;

END $$;
