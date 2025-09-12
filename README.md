# 📧 Communications Block - Email Marketing Plugin for Motorical

[![Production Ready](https://img.shields.io/badge/Status-Production%20Ready-brightgreen.svg)](https://github.com/gliepins/marketing-motorical)
[![Plugin Architecture](https://img.shields.io/badge/Architecture-Plugin-blue.svg)](https://motorical.com)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-blue.svg)](https://postgresql.org/)

> **A production-ready email marketing plugin that seamlessly integrates with the [Motorical](https://motorical.com) email infrastructure ecosystem.**

---

## 🚀 **What is Communications Block?**

Communications Block is an **enterprise-grade email marketing plugin** designed specifically for the **[Motorical](https://motorical.com) ecosystem**. It transforms any Motorical-powered email infrastructure into a complete marketing automation platform while maintaining the plugin architecture principles of independence, scalability, and easy deployment.

### **🎯 Plugin Philosophy**

- **🔌 Truly Pluggable**: Add or remove without affecting core Motorical services
- **🏗️ Independently Deployable**: Own database, services, and repository
- **🌐 API-First Integration**: Loose coupling via REST APIs and environment configuration
- **⚡ Production Battle-Tested**: Live in production with active customers and real campaigns

---

## 🏢 **Part of the Motorical Ecosystem**

### **🌟 [Motorical.com](https://motorical.com) - Professional Email Infrastructure**

The Communications Block leverages the powerful **Motorical** email delivery platform:

- **🚀 High-Performance SMTP**: Enterprise-grade email delivery infrastructure
- **📊 Advanced Analytics**: Real-time delivery intelligence and reputation monitoring  
- **🔐 Security-First**: DKIM signing, SPF/DMARC alignment, dedicated IPs
- **📈 Scalability**: Handle millions of emails with intelligent rate limiting
- **🛡️ Deliverability**: Professional reputation management and ISP relationships

**Perfect for:**
- SaaS platforms needing transactional + marketing emails
- Agencies managing multiple client email campaigns  
- E-commerce businesses requiring reliable email delivery
- Enterprise teams needing advanced email infrastructure

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
- **Smart Status Computation**: Real-time engagement classification (new → sent → delivered → engaged)
- **Advanced Filtering**: Multi-criteria filtering with pagination and sorting
- **Bulk Operations**: Soft delete, bulk move, restore with transaction safety
- **Recycle Bin**: Safety-first approach with accident recovery
- **Engagement Tracking**: Click events automatically update recipient status

### **📈 Google Analytics Integration**
- **SendGrid-Style UTM Control**: Customer manages their own GA parameters
- **Dual Attribution**: Platform tracking + customer GA attribution simultaneously
- **UTM Preservation**: Existing customer UTMs never overwritten
- **Campaign-Level Configuration**: Per-campaign GA settings with full transparency

### **🎯 Production-Ready Campaign System**
- **Visual Campaign Builder**: Material-UI integrated campaign creation workflow
- **List Selection UI**: Enhanced dropdown with checkboxes and smart feedback
- **Real-Time Preview**: Compiled HTML preview with merge tag substitution
- **Link Processing Report**: Detailed analysis of tracked vs. preserved links

### **🛡️ Enterprise Security & Compliance**
- **Security Validation**: HTML size caps, DOM node limits, suspicious pattern detection
- **JWT Click Tracking**: Signed tokens with tenant isolation and expiration
- **Customer-Scoped Suppressions**: Industry-standard unsubscribe management
- **GDPR Ready**: Soft delete patterns with data retention controls
- **Audit Logging**: Complete activity tracking with tenant isolation

### **⚡ Performance & Scalability**
- **Database Optimization**: Enhanced recipient_status view with real-time analytics
- **Connection Pooling**: PostgreSQL pool management for high concurrency
- **Background Processing**: Asynchronous campaign compilation and sending
- **Rate Limiting**: Respects Motorical platform rate controls

---

## 🔌 **Plugin Architecture**

### **How It Plugs Into Motorical**

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
│                Communications Block Plugin                 │
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
| **Email Delivery** | REST API | Uses Motorical's `/v1/send` endpoint for email delivery |
| **Analytics** | Webhook | Receives delivery events from Motorical platform |

### **🎯 Plugin Benefits**

- **✅ Independent Deployment**: Deploy, update, scale independently
- **✅ Zero Downtime**: Add/remove without affecting core Motorical services  
- **✅ Separate Repository**: Own git history, releases, and development cycle
- **✅ Custom Database**: Isolated data with own backup/recovery procedures
- **✅ Modular Features**: Enable only the marketing features you need

---

## 🛠️ **Quick Start**

### **Prerequisites**

- **Motorical Platform**: Running Motorical email infrastructure ([Get Motorical](https://motorical.com))
- **Node.js**: v20+ 
- **PostgreSQL**: v15+
- **Redis**: v6+ (for background job processing)
- **Nginx**: For reverse proxy (or similar load balancer)

### **Installation**

```bash
# 1. Clone the plugin repository
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
# Communications Block Configuration
COMM_PORT=3011
COMM_DB_URL=postgresql://user:pass@localhost:5432/communications_db

# Motorical Integration
MOTORICAL_API_BASE=https://api.motorical.com
MOTORICAL_API_KEY=mb_your_api_key
COMM_INTERNAL_TOKEN=your_secure_internal_token

# Email Configuration
COMM_FROM_ADDRESS=noreply@yourdomain.com
COMM_PUBLIC_BASE=https://yourdomain.com

# Security
SERVICE_JWT_SECRET=your_jwt_secret
```

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
}

# Unsubscribe tracking
location /t/ {
    proxy_pass http://127.0.0.1:3011;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_intercept_errors off;
}
```

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

```bash
# Development setup
git clone https://github.com/gliepins/marketing-motorical.git
cd marketing-motorical
npm install
npm run dev
```

### **Plugin Guidelines**

- Maintain plugin boundaries: No direct connections to main Motorical DB
- API-first integration: All communication via REST APIs
- Environment-driven configuration: No hard-coded integration points
- Independent deployability: Deploy without main platform changes

---

## 📝 **License**

MIT License - see [LICENSE](LICENSE) file for details.

---

## 🌟 **Get Started with Motorical**

Ready to supercharge your email infrastructure? 

👉 **[Visit Motorical.com](https://motorical.com)** for professional email delivery infrastructure.

📧 **Contact**: [support@motorical.com](mailto:support@motorical.com)  
🌐 **Website**: [https://motorical.com](https://motorical.com)  
📚 **Documentation**: [https://docs.motorical.com](https://docs.motorical.com)

---

**Built with ❤️ for the Motorical ecosystem**
