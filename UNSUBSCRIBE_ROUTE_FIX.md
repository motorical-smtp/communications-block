# Unsubscribe Route Fix - Proxy Configuration

## Issue
Unsubscribe links point to `https://api.motorical.com/t/u/...` but return "Route not found" because the route exists on the Communications Block service (port 3011), not on the main API server.

## Root Cause
- `COMM_PUBLIC_BASE` is set to `api.motorical.com`
- Unsubscribe URLs are generated as: `https://api.motorical.com/t/u/{token}`
- The route `/t/u/:token` exists in Communications Block service (port 3011)
- `api.motorical.com` doesn't have this route, so it returns 404

## Solution
Add a proxy rule on `api.motorical.com` (OVH24) to forward `/t/u/*` requests to the Communications Block service.

### Nginx Configuration (on OVH24)

Add this to the nginx config for `api.motorical.com`:

```nginx
location /t/u/ {
    proxy_pass http://localhost:3011;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Express Proxy (if using Express on api.motorical.com)

If `api.motorical.com` is served by Express, add this middleware:

```javascript
const { createProxyMiddleware } = require('http-proxy-middleware');

app.use('/t/u', createProxyMiddleware({
  target: 'http://localhost:3011',
  changeOrigin: true,
  pathRewrite: {
    '^/t/u': '/t/u'  // Keep the path as-is
  }
}));
```

### Verification

After adding the proxy:
1. Test: `curl https://api.motorical.com/t/u/test-token`
2. Should proxy to Communications Block service
3. Should return unsubscribe page (or error if token invalid)

## Alternative Solution

If you prefer not to proxy, change `COMM_PUBLIC_BASE` to point directly to Communications Block:

```bash
COMM_PUBLIC_BASE=https://comm.motorical.com  # or whatever domain serves Communications Block
```

Then update the Communications Block service to be accessible at that domain.

## Current Status

✅ Route exists in Communications Block: `GET /t/u/:token`  
✅ Route handler implemented: `handleUnsub` function  
✅ 404 handler added for better error messages  
⏳ **Pending**: Proxy configuration on OVH24

