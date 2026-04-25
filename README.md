# Communications Block

Communications Block is the marketing automation module for the Motorical SMTP ecosystem. It adds contact lists, segmentation, reusable templates, campaign scheduling, suppressions, tracking, and analytics on top of Motorical's existing email delivery infrastructure.

This repository is public as a reference implementation of the Communications Block module. The module is independently deployable, but it is not a standalone email platform: production use depends on Motorical account, tenant, queue, analytics, and delivery services.

## Current Product Positioning

- Communications Block requires a Motorical Business Plan or higher.
- The module runs as a separate microservice alongside Motorical core.
- Marketing traffic is isolated from transactional SMTP flows while still using the same delivery engine, reputation stack, and analytics systems.
- The public customer API is documented at [docs.motorical.com/communications/api-reference](https://docs.motorical.com/communications/api-reference).

## What It Provides

### Campaign Management

- Contact lists and segmentation
- HTML and text templates with merge variables
- Campaign creation, scheduling, cancellation, soft deletion, and restore flows
- Multi-list targeting with recipient deduplication
- Real-time delivery, click, unsubscribe, and campaign event visibility

### Templates

- HTML and text template storage
- Merge variables such as `{{name}}`, `{{identity_name}}`, and `{{unsubscribe_url}}`
- Non-destructive template validation and preview via `POST /comm-api/api/templates/validate`
- Plain-text fallback support for production email clients

### Compliance And Safety

- CAN-SPAM unsubscribe workflows
- Customer-scoped suppressions
- GDPR data export support
- Soft-delete and restore patterns for campaigns and recipients
- Tenant-scoped API access through `X-Tenant-Id`

### Analytics

- Campaign stats and analytics summaries
- Campaign delivery events
- URL-level click breakdowns
- Recipient search, filtering, export, restore, and cleanup operations
- Suppression statistics and bounce import workflows

## Architecture

Communications Block follows the same architecture described in the public Motorical docs:

1. A customer creates lists, templates, and campaigns in Communications Block.
2. The sender worker writes campaign delivery jobs into Motorical's shared delivery queue.
3. Motorical's delivery engine and Postfix deliver campaign messages through the same production delivery paths as transactional mail.
4. Analytics and reputation services track marketing and transactional traffic while policy can still be applied per Motorical SMTP Motor Block.

Main module components:

- Comm API on port `3011`
- Communications database with isolated marketing data
- Sender worker for campaign delivery
- Stats worker for event and analytics processing

## Public API

Customer-facing endpoints are served under:

```text
https://motorical.com/comm-api/api
```

Every customer-facing endpoint requires:

```text
X-Tenant-Id: your-tenant-uuid
```

Core endpoint groups:

| Area | Examples |
| --- | --- |
| Lists and contacts | `GET /lists`, `POST /lists`, `POST /contacts/upsert`, `POST /lists/{id}/contacts/import` |
| Templates | `GET /templates`, `POST /templates/validate`, `POST /templates`, `PATCH /templates/{id}` |
| Campaigns | `GET /campaigns`, `POST /campaigns`, `POST /campaigns/{id}/schedule`, `GET /campaigns/{id}/analytics` |
| Recipients | `GET /recipients`, `POST /recipients/filter`, `POST /recipients/export`, `POST /recipients/restore` |
| Suppressions | `GET /suppressions`, `POST /suppressions`, `POST /suppressions/import-bounces` |
| Tracking and analytics | `GET /tracking/events`, `GET /tracking/stats`, `GET /unsubscribe-analytics` |
| Data controls | `GET /gdpr/export`, `GET /health` |

See the full API reference:

- [Communications API Reference](https://docs.motorical.com/communications/api-reference)
- [Campaign Management](https://docs.motorical.com/communications/campaigns)
- [Email Templates](https://docs.motorical.com/communications/templates)
- [Lists and Subscribers](https://docs.motorical.com/communications/lists-and-subscribers)
- [Suppressions](https://docs.motorical.com/communications/suppressions)
- [Tracking and Analytics](https://docs.motorical.com/communications/tracking-and-analytics)

## Local Development

Install dependencies:

```bash
npm install
```

Typical development commands:

```bash
npm run dev
npm run worker
npm run stats
```

Important environment variables:

```bash
COMM_PORT=3011
COMM_HOST=127.0.0.1
COMM_DB_URL=postgresql://comm_user:password@localhost:5432/communications_db
MOTORICAL_DB_URL=postgresql://motorical:password@localhost:5432/motorical_db
MOTORICAL_API_BASE=https://api.motorical.com
COMM_INTERNAL_TOKEN=change-me
SERVICE_JWT_SECRET=change-me
```

Production deployments also require access to Motorical's delivery queue, account data, tenant provisioning flow, and reverse proxy routing for `/comm-api/`.

## Repository Status

This repository is maintained under the Motorical SMTP organization:

```text
https://github.com/motorical-smtp/communications-block
```

The current product documentation lives at:

```text
https://docs.motorical.com/communications/overview
```
