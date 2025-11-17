# 📧 Communications Block - Email Marketing Module for Motorical

[![Production Ready](https://img.shields.io/badge/Status-Production%20Ready-brightgreen.svg)](https://github.com/gliepins/marketing-motorical)
[![Click Tracking](https://img.shields.io/badge/Click%20Tracking-Operational-success.svg)](https://track.motorical.com)
[![Module Architecture](https://img.shields.io/badge/Architecture-Module-blue.svg)](https://motorical.com)
[![Open Source](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-blue.svg)](https://postgresql.org/)

> **A production-ready email marketing module that seamlessly integrates with the [Motorical](https://motorical.com) email infrastructure ecosystem. Open source to demonstrate transparency and the module architecture approach.**

---

## 🌟 **Why This Repository is Public**

This repository is **open source** to demonstrate **transparency** and **openness** about the Communications Block approach and the broader Motorical ecosystem architecture. While the main Motorical platform remains closed-source, this module serves as a **reference implementation** showing:

- **🔍 Transparent Architecture**: See exactly how modules integrate with the Motorical ecosystem
- **📚 Educational Value**: Learn from a production-ready email marketing system
- **🔌 Module Pattern**: Understand the module architecture and integration approach
- **🏗️ Best Practices**: Reference implementation for building Motorical ecosystem modules
- **🤝 Community Trust**: Open codebase demonstrates commitment to transparency

**The main Motorical platform** (backend API, frontend, SMTP gateway, delivery engine) remains **closed-source** for business reasons, but this module demonstrates the **extensible architecture** that makes Motorical powerful.

> **Note**: This is a **tightly integrated module**, not a standalone plugin. It requires Motorical's database, queue system, and account infrastructure to function. See [PLUGGABILITY_ASSESSMENT.md](PLUGGABILITY_ASSESSMENT.md) for detailed integration analysis.

---

## 🚀 **What is Communications Block?**

Communications Block is an **enterprise-grade email marketing module** designed specifically for the **[Motorical](https://motorical.com) ecosystem**. It extends Motorical's email infrastructure with complete marketing automation capabilities, tightly integrated with Motorical's core services for seamless operation.

### **📬 Flexible Email Infrastructure Support**

Originally developed as a marketing automation module, Communications Block has been **adopted and extended** to work seamlessly with various email infrastructure setups, including:

- **📧 Simple IMAP Mailboxes**: Works with standard IMAP-based email systems
- **🚀 SMTP Gateway Integration**: Leverages Motorical's high-performance SMTP infrastructure
- **📊 Multi-Tenant Campaigns**: Supports complex marketing workflows
- **🔌 Module Architecture**: Tightly integrated with Motorical for seamless operation

This flexibility makes Communications Block suitable for everything from simple email marketing campaigns to complex multi-tenant marketing automation platforms.

### **🎯 Module Philosophy**

- **🔌 Integrated Module**: Deeply integrated with Motorical's core infrastructure
- **🏗️ Independently Deployable**: Own database, services, and repository
- **🌐 API-First Integration**: Uses Motorical APIs and direct database access for performance
- **⚡ Production Battle-Tested**: Live in production with active customers and real campaigns
- **🔓 Open & Transparent**: Public repository demonstrates architecture and approach
- **📬 Flexible Infrastructure**: Works with SMTP gateways, IMAP mailboxes, and various email setups

---

## 🏢 **Part of the Motorical Ecosystem**

### **🌟 [Motorical.com](https://motorical.com) - Professional Email Infrastructure**

The Communications Block leverages the powerful **Motorical** email delivery platform:

- **🚀 High-Performance SMTP**: Enterprise-grade email delivery infrastructure
- **📊 Advanced Analytics**: Real-time delivery intelligence and reputation monitoring  
- **🔐 Security-First**: DKIM signing, SPF/DMARC alignment, dedicated IPs
- **📈 Scalability**: Handle millions of emails with intelligent rate limiting
- **🛡️ Deliverability**: Professional reputation management and ISP relationships
- **📬 IMAP Support**: Works seamlessly with simple IMAP mailboxes and standard email infrastructure

**Perfect for:**
- SaaS platforms needing transactional + marketing emails
- Agencies managing multiple client email campaigns  
- E-commerce businesses requiring reliable email delivery
- Enterprise teams needing advanced email infrastructure
- **Simple IMAP mailbox users** who want marketing automation capabilities
- **Multi-tenant platforms** requiring flexible email marketing solutions

👉 **[Get started with Motorical →](https://motorical.com)**

---

## ✨ **Features (Production v2.0)**

### **🎯 Compile-Before-Send Architecture**
- **Immutable Campaigns**: Pre-processed artifacts ensure predictable sends
- **HTML Processing**: Security validation, CSS inlining, link tracking integration
- **UTM Management**: Preserve customer UTMs while adding tracking parameters
- **Link Tracking**: JWT-secured click tracking with engagement analytics
- **Plaintext Generation**: Intelligent HTML-to-text conversion for multi-part emails

### **📊 Mega List - Excel-Like Recipient Management**
- **Smart Status Computation**: Real-time engagement classification (new → sent → delivered → engaged) ✅ **OPERATIONAL**
- **Advanced Filtering**: Multi-criteria filtering with pagination and sorting ✅ **OPERATIONAL**
- **Bulk Operations**: Soft delete, bulk move, restore with transaction safety ✅ **OPERATIONAL**
- **Recycle Bin**: Safety-first approach with accident recovery ✅ **OPERATIONAL**
- **Engagement Tracking**: Click events automatically update recipient status ✅ **OPERATIONAL**

### **📈 Google Analytics Integration**
- **SendGrid-Style UTM Control**: Customer manages their own GA parameters ✅ **OPERATIONAL**
- **Dual Attribution**: Platform tracking + customer GA attribution simultaneously ✅ **OPERATIONAL**
- **UTM Preservation**: Existing customer UTMs never overwritten ✅ **OPERATIONAL**
- **Campaign-Level Configuration**: Per-campaign GA settings with full transparency ✅ **OPERATIONAL**

### **🎯 Production-Ready Campaign System**
- **Visual Campaign Builder**: Material-UI integrated campaign creation workflow
- **List Selection UI**: Enhanced dropdown with checkboxes and smart feedback
- **Real-Time Preview**: Compiled HTML preview with merge tag substitution
- **Link Processing Report**: Detailed analysis of tracked vs. preserved links

### **🛡️ Enterprise Security & Compliance**
- **Security Validation**: HTML size caps, DOM node limits, suspicious pattern detection
- **JWT Click Tracking**: Signed tokens with tenant isolation and expiration ✅ **OPERATIONAL**
- **Customer-Scoped Suppressions**: Industry-standard unsubscribe management
- **GDPR Ready**: Soft delete patterns with data retention controls
- **Audit Logging**: Complete activity tracking with tenant isolation

### **⚡ Performance & Scalability**
- **Database Optimization**: Enhanced recipient_status view with real-time analytics
- **Connection Pooling**: PostgreSQL pool management for high concurrency
- **Background Processing**: Asynchronous campaign compilation and sending
- **Rate Limiting**: Respects Motorical platform rate controls

---

## 🔌 **Module Architecture**

### **How It Integrates With Motorical**

```
┌─────────────────────────────────────────────────────────────┐
│                    Motorical Core Platform                 │
├─────────────────┬─────────────────┬─────────────────────────┤
│ Backend API     │ Frontend App    │ SMTP Gateway            │
│ Port 3001       │ Port 3000       │ Port 2587               │
│ Main Database   │ Material-UI     │ Email Delivery          │
└─────────────────┴─────────────────┴─────────────────────────┘
                           │
        ┌─────────────────────────────────────────────────┐
        │              Integration Layer                  │
        │ • Nginx Reverse Proxy (/comm-api/* → :3011)   │
        │ • Tenant Provisioning (X-Internal-Token)       │
        │ • Frontend Pages (Material-UI Integration)     │
        └─────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────────┐
│                Communications Block Module                 │
├─────────────────┬─────────────────┬─────────────────────────┤
│ Comm API        │ Comm Database   │ Background Workers      │
│ Port 3011       │ communications  │ Sender + Stats          │
│ REST Endpoints  │ _db             │ Campaign Processing     │
└─────────────────┴─────────────────┴─────────────────────────┘
```

### **🔗 Integration Points**

| Integration | Type | Description |
|-------------|------|-------------|
| **Authentication** | HTTP API | Tenant provisioning via `X-Internal-Token` |
| **Frontend** | Reverse Proxy | Nginx routes `/comm-api/*` to Communications Block |
| **Email Delivery** | Direct DB + Queue | Inserts into `motorical_db.email_logs` and LPUSHes to Redis `email_delivery_queue` via selected motor block |
| **Analytics** | Webhook + API | Receives delivery events from Motorical platform and polls API for logs |
| **Account System** | Database | Uses `motorical_account_id` for tenant scoping and suppressions |

### **🎯 Module Benefits**

- **✅ Independent Deployment**: Deploy, update, scale independently
- **✅ Separate Repository**: Own git history, releases, and development cycle
- **✅ Custom Database**: Isolated data with own backup/recovery procedures
- **✅ Modular Features**: Enable only the marketing features you need
- **✅ Deep Integration**: Direct access to Motorical infrastructure for optimal performance
- **✅ Transparent Architecture**: Open source code demonstrates integration patterns

---

## 🛠️ **Quick Start**

### **Prerequisites**

- **Motorical Platform**: Running Motorical email infrastructure ([Get Motorical](https://motorical.com))
  - **Required**: Access to `motorical_db` database
  - **Required**: Access to Motorical's Redis `email_delivery_queue`
  - **Required**: Motorical account system (`motorical_account_id`)
- **Node.js**: v20+ 
- **PostgreSQL**: v15+ (for Communications Block database + access to Motorical database)
- **Redis**: v6+ (shared with Motorical platform)
- **Nginx**: For reverse proxy (or similar load balancer)

### **Installation**

```bash
# 1. Clone the module repository
git clone https://github.com/gliepins/marketing-motorical.git
cd marketing-motorical

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your Motorical API credentials

# 4. Setup database
sudo -u postgres psql -c "CREATE DATABASE communications_db;"
sudo -u postgres psql -c "CREATE USER comm_user WITH PASSWORD 'secure_password';"
sudo -u postgres psql -d communications_db -f migrations/0001_init.sql
sudo -u postgres psql -d communications_db -f migrations/0002_customer_scoped_suppressions.sql
sudo -u postgres psql -d communications_db -f migrations/0003_compile_before_send.sql   # Phase 1

# 5. Start services
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now motorical-comm-api motorical-comm-sender motorical-comm-stats

# 6. Verify installation
curl -f http://localhost:3011/api/health
```

---

## 🔧 **Configuration**

### **Environment Variables**

```bash
# Communications Block (own DB)
COMM_PORT=3011
COMM_DB_URL=postgresql://comm_user:password@localhost:5432/communications_db

# Motorical Platform (main DB) for delivery queue
MOTORICAL_DB_URL=postgresql://motorical:password@localhost:5432/motorical_db

# Motorical Integration (optional REST helpers)
MOTORICAL_API_BASE=https://api.motorical.com
MOTORICAL_API_KEY=mb_your_api_key
COMM_INTERNAL_TOKEN=your_secure_internal_token

# Email Configuration
COMM_FROM_ADDRESS=noreply@yourdomain.com
COMM_PUBLIC_BASE=https://yourdomain.com

# Sender transport toggle (default off)
COMM_SMTP_ENABLE=false
# If you ever enable SMTP fallback explicitly (not recommended):
# COMM_SMTP_HOST=mail.motorical.com
# COMM_SMTP_PORT=2587
# COMM_SMTP_USER=...
# COMM_SMTP_PASS=...

# Security
SERVICE_JWT_SECRET=your_jwt_secret
```

### Sending Flow (v2.1)

- Campaign carries a `motor_block_id` selection.
- Sender worker compiles payload and enqueues delivery via Motorical pipeline:
  - Insert row into `motorical_db.public.email_logs` with status `queued` and metadata.
  - LPUSH JSON job to Redis list `email_delivery_queue` for the Delivery Engine.
- SMTP fallback is disabled by default to prevent mismatch with campaign motor block selection.

### **Nginx Integration**

```nginx
# Add to your Motorical frontend Nginx config
location /comm-api/ {
    proxy_pass http://127.0.0.1:3011/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Click tracking integration (v2.0)
location /c/ {
    proxy_pass http://127.0.0.1:3011;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_intercept_errors off;
    # Prevent caching of dynamic redirects at edge/proxies
    add_header Cache-Control "no-store" always;
}

# Unsubscribe tracking
location /t/ {
    proxy_pass http://127.0.0.1:3011;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_intercept_errors off;
    add_header Cache-Control "no-store" always;
}
```

#### Security Notes (track.motorical.com)
- Behind Cloudflare, set SSL mode to Full (Strict) and bypass cache for `/c/*` and `/t/*`.
- Do not enable features that inject scripts (e.g., Rocket Loader) to preserve strict CSP.
- Keep JWT click tokens short‑lived and validate `iss`, `aud`, `exp`; redirect only to targets embedded in the signed token (no open redirects).
- Preserve real client IP at origin with `real_ip_header CF-Connecting-IP` and `set_real_ip_from` for Cloudflare ranges.

### **v2.0 Technical Architecture**

**Production-Ready Infrastructure:**
- **Database**: 5 migrations with UUID compliance and real-time analytics integration
- **Services**: 3 systemd services (API, sender worker, stats worker) with health monitoring
- **Security**: JWT-based click tracking with tenant isolation and expiration policies
- **Performance**: Connection pooling, background processing, and optimized database views
- **Reliability**: Soft delete patterns, transaction safety, and comprehensive error handling

**New v2.0 Components:**
- **Compile Hooks System**: Extensible pre/post-compile processing (security, metrics, link processing)
- **Link Processor**: UTM preservation, tracking wrapping, and do-not-track enforcement
- **HTML-to-Text Engine**: Intelligent plaintext generation from customer HTML
- **Recipient Status View**: Real-time classification engine for engagement tracking
- **Bulk Operations Engine**: Transaction-safe bulk processing with audit logging

---

## 📊 **API Reference**

### **🧪 Interactive API Sandbox**

**Try the Communications Block APIs with realistic demo data - no signup required!**

👉 **[API Documentation & Playground →](https://motorical.com/public-api/docs)**  
👉 **[Advanced API Testing →](https://motorical.com/settings/api-access)**

The sandbox includes **comprehensive demo data** for:
- **📈 Real-time Analytics**: Campaign performance metrics, delivery rates, engagement tracking
- **📝 Email Logs**: Searchable message history with detailed metadata
- **⚡ Rate Limits**: Current usage, quotas, and reset times  
- **🎯 Deliverability**: Domain-specific performance analytics
- **🔍 Recipient Analytics**: Individual contact delivery insights
- **📊 Campaign Intelligence**: Advanced reporting and ROI analysis

### **Core Communications Block v2.0 Endpoints**

```bash
# Tenant Management
POST   /api/provision/tenant     # Provision new tenant (internal)

# Lists & Contacts Management
GET    /api/lists                # Get all lists with metadata
POST   /api/lists                # Create new list
POST   /api/lists/from-filter    # Create list from Mega List filter
DELETE /api/lists/:id            # Soft delete list
POST   /api/lists/:id/contacts/import  # CSV import with validation
POST   /contacts/:id/unsubscribe # Add to customer suppression list
PUT    /contacts/:id/resubscribe # Remove from customer suppression list

# Mega List - Excel-Like Recipient Management
GET    /api/recipients           # Advanced filtering with pagination
GET    /api/recipients/deleted   # Recycle bin view
POST   /api/recipients/bulk-delete    # Soft delete multiple recipients  
POST   /api/recipients/bulk-move      # Move recipients between lists
POST   /api/recipients/restore        # Restore from recycle bin

# Templates
GET    /api/templates            # Get all templates
POST   /api/templates            # Create template with HTML validation
DELETE /api/templates/:id        # Delete template (with confirmation)

# Campaign Management (Compile-Before-Send)
GET    /api/campaigns            # Get campaigns with compilation status
POST   /api/campaigns            # Create campaign with GA integration
POST   /api/campaigns/:id/compile      # Compile with link processing & security validation
GET    /api/campaigns/:id/artifacts    # Get compiled artifacts & metadata
POST   /api/campaigns/:id/schedule     # Schedule with immutable artifacts
GET    /api/campaigns/:id/analytics    # Enhanced analytics with list attribution
GET    /api/campaigns/:id/recipients   # Recipients with engagement status
GET    /api/campaigns/:id/events       # Email events with click tracking
DELETE /api/campaigns/:id        # Delete campaign (with confirmation)

# Click Tracking (JWT-Secured)
GET    /c/:token                 # Click tracking redirect
GET    /t/u/:token              # Unsubscribe tracking

# Analytics & Insights
GET    /api/analytics/dashboard  # Tenant-wide marketing analytics
GET    /api/analytics/lists/:id  # Per-list performance insights
```

### **🔗 Motorical Platform Integration APIs**

**Available via the main [Motorical Public API](https://motorical.com/settings/api-access):**

```bash
# Motor Block Analytics (Perfect for Communications Block integration)
GET    /api/public/v1/motor-blocks                    # List motor blocks
GET    /api/public/v1/motor-blocks/{id}/rate-limits   # Usage quotas & limits
GET    /api/public/v1/motor-blocks/{id}/metrics       # Time-series delivery metrics
GET    /api/public/v1/motor-blocks/{id}/logs          # Searchable email logs
GET    /api/public/v1/motor-blocks/{id}/deliverability # Domain performance analysis
GET    /api/public/v1/motor-blocks/{id}/reputation    # Sender reputation scoring
GET    /api/public/v1/motor-blocks/{id}/anomalies     # Delivery anomaly detection
GET    /api/public/v1/messages/{messageId}            # Individual message lookup

# Webhook Management (For real-time event processing)
GET    /api/public/v1/motor-blocks/{id}/webhooks      # List webhooks
POST   /api/public/v1/motor-blocks/{id}/webhooks      # Create webhook
PUT    /api/public/v1/motor-blocks/{id}/webhooks/{id} # Update webhook
DELETE /api/public/v1/motor-blocks/{id}/webhooks/{id} # Delete webhook

# Real-time Event Streaming
GET    /api/public/v1/motor-blocks/{id}/events/stream # Server-Sent Events (SSE)
```

### **🚀 Communications Block API Enhancement Opportunities**

**To maximize the value for Communications Block users, consider these additional API endpoints:**

```bash
# Enhanced Campaign Analytics (Future roadmap)
GET    /api/campaigns/:id/recipient-insights          # Per-recipient deliverability scores
GET    /api/campaigns/:id/domain-performance          # Domain-specific delivery analytics  
GET    /api/campaigns/:id/engagement-timeline         # Hour-by-hour engagement patterns
GET    /api/campaigns/:id/cohort-analysis             # A/B testing and segment performance

# Advanced Suppression Management
GET    /api/suppressions/recommendations              # AI-powered suppression suggestions
GET    /api/suppressions/cross-campaign               # Global suppression analytics
POST   /api/suppressions/validate                     # Validate email deliverability

# Real-time Communications Intelligence  
GET    /api/intelligence/optimal-send-times           # Best send times by domain/recipient
GET    /api/intelligence/content-analysis             # Subject line and content scoring
GET    /api/intelligence/reputation-monitoring        # Sender reputation alerts
GET    /api/intelligence/deliverability-forecast      # Predictive delivery analytics

# Integration with Motorical Platform Analytics
GET    /api/hybrid/campaign-motor-block-stats         # Unified campaign + motor block metrics
GET    /api/hybrid/recipient-delivery-journey         # End-to-end delivery tracking
GET    /api/hybrid/performance-benchmarking          # Industry benchmark comparisons
```

**🎯 Why These Matter for Communications Block:**
- **📊 Campaign Optimization**: Data-driven decisions for better engagement
- **🎯 Precision Targeting**: AI-powered insights for optimal delivery
- **🔍 Delivery Intelligence**: Deep recipient and domain analytics
- **📈 Performance Benchmarking**: Industry comparison and improvement recommendations
- **⚡ Real-time Optimization**: Dynamic send-time and content optimization

---

## 🏗️ **Architecture**

### **Database Schema**

```sql
-- Core Tables
tenants(id, motorical_account_id, status, created_at)
contacts(id, tenant_id, email, name, status, ...)
lists(id, tenant_id, name, description, ...)
templates(id, tenant_id, name, subject, body_html, body_text, ...)
campaigns(id, tenant_id, name, template_id, motor_block_id, status, ...)

-- Customer-Scoped Suppressions
suppressions(id, motorical_account_id, tenant_id, email, reason, source, ...)
  -- UNIQUE(motorical_account_id, email) for cross-customer isolation

-- Analytics & Events
email_events(id, tenant_id, campaign_id, contact_id, message_id, type, occurred_at, ...)

-- Phase 1 Additions (Compile-Before-Send)
comm_campaign_artifacts(
  id UUID PK, tenant_id UUID, campaign_id UUID, version INT,
  subject TEXT, html_compiled TEXT, text_compiled TEXT, meta JSONB, created_at TIMESTAMP
)
comm_audience_snapshots(
  id UUID PK, tenant_id UUID, campaign_id UUID, version INT,
  total_recipients INT, included_lists JSONB, deduped_by TEXT, filters JSONB, created_at TIMESTAMP
)
```

### **Services**

- **Comm API** (Port 3011): REST endpoints and business logic
- **Sender Worker**: Campaign processing and email delivery
- **Stats Worker**: Real-time analytics and event processing

---

## 🚀 **Production**

### **Health Monitoring**

```bash
# Health check
curl -f http://localhost:3011/api/health

# Service status
sudo systemctl status motorical-comm-*

# Logs
sudo journalctl -u motorical-comm-* -f
```

### **Backup & Recovery**

```bash
# Database backup
pg_dump -U comm_user communications_db > backup_$(date +%Y%m%d_%H%M%S).sql

# Service restart
sudo systemctl restart motorical-comm-api motorical-comm-sender motorical-comm-stats
```

---

## 🤝 **Contributing**

We welcome contributions! This open-source module demonstrates the Motorical ecosystem's extensibility and integration patterns.

```bash
# Development setup
git clone https://github.com/gliepins/marketing-motorical.git
cd marketing-motorical
npm install
npm run dev
```

### **Module Guidelines**

- **Clear integration boundaries**: Direct access to `motorical_db` for `email_logs` and account system
- **Platform queue integration**: Uses Motorical's `email_delivery_queue` for email delivery
- **Environment-driven configuration**: Configuration via environment variables
- **Independent deployability**: Deploy without main platform changes
- **Support multiple infrastructures**: Works with SMTP gateways, IMAP mailboxes, and standard email systems
- **Transparency first**: Code should be clear, documented, and demonstrate integration patterns

### **Why Contribute?**

- **🌍 Real-World Impact**: Your contributions help real businesses send better emails
- **📚 Learning Opportunity**: Understand production-grade email marketing systems
- **🔍 Transparency**: Help demonstrate open, extensible architecture
- **🚀 Innovation**: Shape the future of email marketing automation

---

## 📝 **License**

MIT License - see [LICENSE](LICENSE) file for details.

This open-source module is provided to demonstrate transparency and the module architecture approach. The main Motorical platform remains closed-source.

---

## 🌟 **Get Started with Motorical**

Ready to supercharge your email infrastructure? 

👉 **[Visit Motorical.com](https://motorical.com)** for professional email delivery infrastructure.

📧 **Contact**: [support@motorical.com](mailto:support@motorical.com)  
🌐 **Website**: [https://motorical.com](https://motorical.com)  
📚 **Documentation**: [https://docs.motorical.com](https://docs.motorical.com)  
💻 **GitHub**: [https://github.com/gliepins/marketing-motorical](https://github.com/gliepins/marketing-motorical)

---

## 🔍 **Transparency & Openness**

This repository is **public** to demonstrate:

- **🏗️ Architecture Transparency**: See how modules integrate with the Motorical ecosystem
- **📚 Educational Value**: Learn from production-ready email marketing code
- **🔌 Module Pattern**: Understand the integration architecture and patterns
- **🤝 Community Trust**: Open codebase shows our commitment to transparency

**Note**: While this module is open-source, the main Motorical platform (backend API, frontend, SMTP gateway, delivery engine) remains closed-source for business reasons. This module serves as a **reference implementation** showing how the ecosystem works.

**Integration Depth**: This is a **tightly integrated module** that requires Motorical's database, queue system, and account infrastructure. See [PLUGGABILITY_ASSESSMENT.md](PLUGGABILITY_ASSESSMENT.md) for detailed analysis of integration points and dependencies.

---

**Built with ❤️ for the Motorical ecosystem | Open source for transparency**
