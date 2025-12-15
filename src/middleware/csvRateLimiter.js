import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Redis client for rate limiting
let redis = null;

function getRedis() {
  if (!redis) {
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || '',
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }
    });

    redis.on('error', (err) => {
      logger.error({ err }, 'Redis rate limiter connection error');
    });
  }
  return redis;
}

/**
 * Rate limiting middleware for CSV uploads
 * Limits: 10 uploads per 15 minutes per tenant
 */
export function csvUploadRateLimiter(req, res, next) {
  const tenantId = req.tenantId;
  if (!tenantId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Tenant ID required for rate limiting' 
    });
  }

  const redisClient = getRedis();
  const key = `csv_upload_rate_limit:${tenantId}`;
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxUploads = 10;

  // Use Redis INCR with expiration for rate limiting
  redisClient.incr(key)
    .then((count) => {
      if (count === 1) {
        // First request in window, set expiration
        return redisClient.pexpire(key, windowMs).then(() => count);
      }
      return count;
    })
    .then((count) => {
      const remaining = Math.max(0, maxUploads - count);
      const resetTime = Date.now() + windowMs;

      // Set rate limit headers
      res.set({
        'X-RateLimit-Limit': maxUploads.toString(),
        'X-RateLimit-Remaining': remaining.toString(),
        'X-RateLimit-Reset': new Date(resetTime).toISOString()
      });

      if (count > maxUploads) {
        logger.warn({ 
          tenantId, 
          count, 
          maxUploads 
        }, 'CSV upload rate limit exceeded');

        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded',
          message: `Maximum ${maxUploads} CSV uploads per 15 minutes. Please try again later.`,
          retryAfter: Math.ceil(windowMs / 1000) // seconds
        });
      }

      next();
    })
    .catch((err) => {
      logger.error({ err, tenantId }, 'Rate limiter error');
      // On Redis error, allow request but log warning
      logger.warn('Rate limiter unavailable, allowing request');
      next();
    });
}

