# Click Tracking Technical Reference

## 🎯 **System Overview**

The Communications Block implements comprehensive click tracking using JWT-secured redirect URLs that preserve customer UTM parameters while capturing engagement analytics.

## 🏗️ **Architecture Components**

### **1. Link Processing Service**
**File**: `/src/services/link-processor.js`
- Wraps customer links with tracking URLs during campaign compilation
- Preserves existing UTM parameters (policy: 'preserve', 'append', 'override')
- Generates JWT tokens for secure click attribution
- Skips tracking for sensitive links (mailto, tel, unsubscribe)

### **2. Tracking API Endpoints**
**File**: `/src/routes/tracking.js`
- `GET /c/:token` - Click tracking with redirect
- `GET /t/:token` - Unsubscribe tracking (future enhancement)
- JWT token verification and click event recording
- 302 redirects to original destination with UTM parameters

### **3. Database Integration**
**Table**: `email_events`
- Records click events with contact_id, campaign_id, tenant_id
- Timestamp tracking for engagement analytics
- Integration with recipient status computation

### **4. Infrastructure Setup**
**Domain**: `track.motorical.com`
- DNS A record pointing to `172.234.116.197`
- SSL certificate covering subdomain
- Nginx proxy routing `/c/` and `/t/` paths to Communications API

## 🔐 **Security Implementation**

### **JWT Token Structure**
```javascript
{
  contactId: "uuid",
  campaignId: "uuid", 
  tenantId: "uuid",
  originalUrl: "https://customer-site.com/page?utm_existing=value",
  iat: timestamp,
  exp: timestamp
}
```

### **Environment Configuration**
```bash
# /etc/motorical/communications-block.env
COMM_TRACKING_DOMAIN=track.motorical.com
SERVICE_JWT_SECRET=<secure-random-string>
JWT_EXPIRE_HOURS=720  # 30 days default
```

### **Security Measures**
- JWT tokens expire after configurable time period (default: 30 days)
- Tokens are signed with secure random secret (not default values)
- Contact-specific tokens prevent cross-tenant data access
- HTTPS-only redirect URLs for security

## 🔄 **Click Processing Flow**

### **1. Campaign Compilation**
```javascript
// Original customer link
<a href="https://yoursite.com/products?utm_campaign=existing">Products</a>

// After compilation (with tracking enabled)
<a href="https://track.motorical.com/c/JWT_TOKEN_HERE">Products</a>
```

### **2. JWT Token Generation**
```javascript
const token = jwt.sign({
  contactId: recipient.id,
  campaignId: campaign.id,
  tenantId: campaign.tenant_id,
  originalUrl: "https://yoursite.com/products?utm_campaign=existing&utm_source=email&utm_medium=newsletter"
}, process.env.SERVICE_JWT_SECRET, { expiresIn: '720h' });
```

### **3. Click Event Processing**
```javascript
// User clicks tracking link → tracking API receives request
GET /c/JWT_TOKEN_HERE

// Token verification and URL extraction
const decoded = jwt.verify(token, process.env.SERVICE_JWT_SECRET);
const { contactId, campaignId, tenantId, originalUrl } = decoded;

// Record click event in database
INSERT INTO email_events (contact_id, campaign_id, tenant_id, type, occurred_at)
VALUES (contactId, campaignId, tenantId, 'clicked', NOW());

// 302 redirect to original destination
HTTP/1.1 302 Found
Location: https://yoursite.com/products?utm_campaign=existing&utm_source=email&utm_medium=newsletter
```

## 📊 **Analytics Integration**

### **Recipient Status Computation**
```sql
-- Enhanced recipient_status view with click tracking
CREATE VIEW recipient_status AS
SELECT 
  c.id, c.tenant_id, c.email, c.name,
  latest_clicks.last_click_at,
  CASE 
    WHEN latest_clicks.last_click_at IS NOT NULL THEN 'engaged'
    WHEN latest_events.last_sent_at IS NOT NULL THEN 'sent'
    ELSE 'new'
  END as computed_status,
  CASE 
    WHEN latest_clicks.click_count >= 3 THEN 'high'
    WHEN latest_clicks.click_count >= 1 THEN 'medium'
    ELSE 'none'
  END as engagement_level
FROM contacts c 
LEFT JOIN (
  SELECT 
    contact_id,
    MAX(occurred_at) as last_click_at,
    COUNT(*) as click_count
  FROM email_events 
  WHERE type = 'clicked' 
  GROUP BY contact_id
) latest_clicks ON latest_clicks.contact_id = c.id
LEFT JOIN (
  SELECT DISTINCT ON (contact_id)
    contact_id,
    occurred_at as last_sent_at,
    campaign_id as last_campaign_id
  FROM email_events 
  WHERE type IN ('queued', 'sent', 'delivered')
  ORDER BY contact_id, occurred_at DESC
) latest_events ON latest_events.contact_id = c.id
WHERE c.deleted_at IS NULL;
```

### **Real-Time UI Updates**
- Mega List queries `recipient_status` view for engagement data
- Recipients show 'engaged' status after first click
- Engagement level progresses: none → medium → high based on click frequency
- Last click timestamps available for detailed analytics

## 🔧 **Configuration Management**

### **Environment Variables**
```bash
# Required for click tracking
COMM_TRACKING_DOMAIN=track.motorical.com  # Must match DNS setup
SERVICE_JWT_SECRET=<64-char-random-string>  # CRITICAL: Never use defaults
JWT_EXPIRE_HOURS=720  # Optional: token expiration (default 30 days)

# Optional for enhanced features  
COMM_TRACKING_PRIVACY_DOMAINS=unsubscribe.motorical.com,privacy.motorical.com
COMM_UTM_DEFAULT_SOURCE=email
COMM_UTM_DEFAULT_MEDIUM=newsletter
```

### **Nginx Configuration**
```nginx
# /etc/nginx/sites-available/track.motorical.com
server {
    server_name track.motorical.com;
    
    location /c/ {
        proxy_pass http://127.0.0.1:3011;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_intercept_errors off;
    }
    
    location /t/ {
        proxy_pass http://127.0.0.1:3011;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_intercept_errors off;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/motorical.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/motorical.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}
```

### **Service Management**
```bash
# Restart services after configuration changes
sudo systemctl restart motorical-comm-api
sudo systemctl restart motorical-comm-sender

# Verify services are operational
sudo systemctl status motorical-comm-api motorical-comm-sender

# Check service logs for tracking errors
sudo journalctl -u motorical-comm-api -f | grep tracking
```

## 🧪 **Testing & Verification**

### **End-to-End Test Process**
1. **Create Test Campaign**: Enable click tracking and GA parameters
2. **Compile Campaign**: Verify tracking links are generated with proper domain
3. **Send Campaign**: Confirm emails contain working tracking URLs
4. **Click Links**: Test actual click-through and redirect functionality
5. **Verify Database**: Check `email_events` table for click records
6. **Check UI**: Confirm Mega List shows updated engagement status

### **Manual Token Testing**
```bash
# Generate test token (for debugging)
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({
  contactId: 'test-contact-uuid',
  campaignId: 'test-campaign-uuid',
  tenantId: 'test-tenant-uuid',
  originalUrl: 'https://example.com'
}, process.env.SERVICE_JWT_SECRET);
console.log('Test token:', token);
"

# Test click tracking endpoint
curl -i "https://track.motorical.com/c/TEST_TOKEN_HERE"
```

### **Database Verification Queries**
```sql
-- Check recent click events
SELECT 
  ee.contact_id, c.email, ee.campaign_id, ee.occurred_at
FROM email_events ee
JOIN contacts c ON c.id = ee.contact_id
WHERE ee.type = 'clicked' 
ORDER BY ee.occurred_at DESC
LIMIT 10;

-- Verify recipient status updates
SELECT email, computed_status, engagement_level, last_click_at
FROM recipient_status 
WHERE computed_status = 'engaged'
ORDER BY last_click_at DESC;

-- Campaign click analytics
SELECT 
  c.name as campaign_name,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT ee.contact_id) as unique_clickers
FROM email_events ee
JOIN campaigns c ON c.id = ee.campaign_id
WHERE ee.type = 'clicked'
GROUP BY c.id, c.name
ORDER BY total_clicks DESC;
```

## 🚨 **Troubleshooting Guide**

### **Common Issues**

**1. "Invalid click token: jwt malformed"**
- **Cause**: Token generation or environment configuration issue
- **Fix**: Verify `SERVICE_JWT_SECRET` is properly set and services restarted
- **Debug**: Check token generation in campaign compilation logs

**2. "Invalid click token: invalid signature"**
- **Cause**: JWT secret mismatch between sender and tracking API
- **Fix**: Ensure same JWT secret in environment file, restart all services
- **Debug**: Verify environment file is properly loaded by services

**3. "Click events not appearing in Mega List"**
- **Cause**: `recipient_status` view not including click data
- **Fix**: Recreate view with click tracking integration (see SQL above)
- **Debug**: Query `email_events` directly to verify clicks are being recorded

**4. "Tracking links not redirecting"**
- **Cause**: Nginx configuration or DNS resolution issues
- **Fix**: Verify nginx proxy configuration and SSL certificates
- **Debug**: Test direct API access: `curl -i http://localhost:3011/c/token`

**5. "UTM parameters missing after redirect"**
- **Cause**: Original URL not properly preserved in JWT token
- **Fix**: Check link processing logic in campaign compilation
- **Debug**: Decode JWT tokens to verify originalUrl contains UTM parameters

### **Debug Commands**
```bash
# Check DNS resolution
nslookup track.motorical.com

# Verify SSL certificate
openssl s_client -connect track.motorical.com:443 -servername track.motorical.com

# Test nginx proxy
curl -i -H "Host: track.motorical.com" http://127.0.0.1/c/test

# Check service logs
sudo journalctl -u motorical-comm-api --since "10 minutes ago"

# Verify JWT secret is loaded
sudo systemctl show motorical-comm-api --property=Environment

# Test database connectivity
sudo -u postgres psql -d communications_db -c "SELECT COUNT(*) FROM email_events WHERE type = 'clicked';"
```

## 📈 **Performance Considerations**

### **Database Optimization**
```sql
-- Essential indexes for click tracking performance
CREATE INDEX IF NOT EXISTS idx_email_events_contact_type_time 
ON email_events(contact_id, type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_events_campaign_type 
ON email_events(campaign_id, type);

CREATE INDEX IF NOT EXISTS idx_email_events_tenant_type_time 
ON email_events(tenant_id, type, occurred_at DESC);
```

### **Caching Strategy**
- JWT tokens are stateless (no server-side session storage required)
- Recipient status computed on-demand with database view
- Consider Redis caching for high-volume click analytics queries
- Nginx caching not recommended (breaks click tracking)

### **Scalability Notes**
- JWT tokens enable horizontal scaling (no shared state)
- Database connection pooling essential for high click volumes
- Monitor `email_events` table growth for large campaigns
- Consider partitioning by date for very high-volume deployments

## 🔒 **Security Best Practices**

### **Production Security Checklist**
- ✅ **JWT Secret**: Strong random string (64+ characters)
- ✅ **Token Expiration**: Reasonable expiry (30 days default)
- ✅ **HTTPS Only**: All tracking URLs use HTTPS
- ✅ **Tenant Isolation**: Tokens include tenant verification
- ✅ **Input Validation**: URL and parameter validation
- ✅ **Rate Limiting**: Consider click frequency limits for abuse prevention

### **Security Monitoring**
```bash
# Monitor for suspicious click patterns
sudo journalctl -u motorical-comm-api | grep "Invalid click token" | tail -20

# Check for token abuse (same token multiple clicks)
SELECT token_hash, COUNT(*) as click_count 
FROM email_events 
WHERE type = 'clicked' AND occurred_at > NOW() - INTERVAL '1 hour'
GROUP BY token_hash 
HAVING COUNT(*) > 10;
```

---

## 📋 **System Status: FULLY OPERATIONAL**

✅ **Infrastructure**: DNS, SSL, Nginx routing operational  
✅ **Security**: JWT signing and verification working  
✅ **Database**: Click events properly recorded and integrated  
✅ **UI Integration**: Real-time engagement status updates  
✅ **End-to-End**: Complete click attribution workflow verified  

**Last Updated**: September 13, 2025  
**Status**: Production Ready - All Components Operational
