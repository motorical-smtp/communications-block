# Nginx Proxy Configuration for Unsubscribe Route

## Issue
Unsubscribe links (`https://api.motorical.com/t/u/...`) return "Route not found" because `api.motorical.com` doesn't proxy `/t/u/*` to the Communications Block service.

## Solution
Add the following nginx configuration to `api.motorical.com` on OVH24.

### Current api.motorical.com Config (from DNS_AND_NGINX_MIGRATION_PLAN.md)

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.motorical.com;

    ssl_certificate /etc/letsencrypt/live/motorical.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/motorical.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Updated Config (Add /t/ proxy BEFORE location /)

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.motorical.com;

    ssl_certificate /etc/letsencrypt/live/motorical.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/motorical.com/privkey.pem;

    # Unsubscribe tracking - MUST be before location /
    location /t/ {
        proxy_pass http://localhost:3011;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_intercept_errors off;
        add_header Cache-Control "no-store" always;
    }

    # Click tracking (if needed)
    location /c/ {
        proxy_pass http://localhost:3011;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_intercept_errors off;
        add_header Cache-Control "no-store" always;
    }

    # Default API proxy
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Implementation Steps (on OVH24)

1. **Edit nginx config**:
   ```bash
   sudo nano /etc/nginx/sites-available/api.motorical.com
   # or wherever the api.motorical.com config is located
   ```

2. **Add `/t/` location block BEFORE `location /`** (order matters!)

3. **Test configuration**:
   ```bash
   sudo nginx -t
   ```

4. **Reload nginx**:
   ```bash
   sudo systemctl reload nginx
   ```

5. **Verify**:
   ```bash
   curl -I https://api.motorical.com/t/u/test-token
   # Should proxy to Communications Block service (port 3011)
   ```

### Why Order Matters

Nginx matches locations in order. If `location /` comes first, it will catch `/t/u/...` and proxy to port 3001 (backend API) instead of port 3011 (Communications Block). The more specific `/t/` location must come first.

### Verification

After adding the proxy:
- Unsubscribe links should work: `https://api.motorical.com/t/u/{token}`
- Should return unsubscribe page from Communications Block service
- Should not return "Route not found" error

