### Communications Block (Service)

Independent service for recipient lists, templates, and campaigns. Uses Motorical APIs for sending and stats.

#### Quick start
1) Copy `.env.example` to `.env` and fill values
2) Create database and run migrations in `migrations/`
3) Start API: `npm start`
4) Start worker: `npm run worker`

#### Environment variables
- COMM_PORT=3011
- COMM_DB_URL=postgresql://motorical:password@localhost:5432/communications_db
- MOTORICAL_API_BASE=https://api.motorical.com
- MOTORICAL_API_KEY=... (for /v1/send)
- MOTORICAL_PUBLIC_API_TOKEN=... (scoped token for /api/public/v1)

#### Health check
- GET /api/health → `{ success: true, data: { status: 'ok' } }`

#### Unsubscribe & Settings (MVP)
- GET /api/settings/unsubscribe
- PATCH /api/settings/unsubscribe
- GET/POST /t/u/:token (idempotent unsubscribe; customer redirect or Motorical page)

#### Provisioning & Entitlements
- POST /api/provision/tenant (internal; header `X-Internal-Token`)
- POST /api/deprovision/tenant (internal; header `X-Internal-Token`)
- Set `COMM_INTERNAL_TOKEN` in `.env`; backend Stripe webhook calls these on add-on changes
- Lists/Templates/Campaigns are permitted only for provisioned tenants (status=active)

#### Systemd units
- See `systemd/motorical-comm-api.service`
- See `systemd/motorical-comm-sender.service`

#### Quick API examples (MVP)
```
TENANT=... # UUID from tenants table (temporary for MVP)

# Create list
curl -H "X-Tenant-Id: $TENANT" -H 'Content-Type: application/json' \
  -d '{"name":"Demo List"}' http://localhost:3011/api/lists

# Upsert contact
curl -H "X-Tenant-Id: $TENANT" -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","name":"Alice"}' http://localhost:3011/api/contacts/upsert

# Add contacts to list
LIST_ID=...
curl -H "X-Tenant-Id: $TENANT" -H 'Content-Type: application/json' \
  -d '{"emails":[{"email":"alice@example.com"},{"email":"bob@example.com","name":"Bob"}]}' \
  http://localhost:3011/api/lists/$LIST_ID/contacts

# Create template
curl -H "X-Tenant-Id: $TENANT" -H 'Content-Type: application/json' \
  -d '{"name":"Welcome","subject":"Hi","type":"html","body_html":"<p>Hello {{name}}</p>"}' \
  http://localhost:3011/api/templates

# Create campaign
TEMPLATE_ID=...
curl -H "X-Tenant-Id: $TENANT" -H 'Content-Type: application/json' \
  -d '{"name":"September Campaign","template_id":"'$TEMPLATE_ID'","list_ids":["'$LIST_ID'"],"motor_block_id":"00000000-0000-0000-0000-000000000000"}' \
  http://localhost:3011/api/campaigns
```


