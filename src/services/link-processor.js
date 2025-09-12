import * as cheerio from 'cheerio';
import crypto from 'crypto';
import pino from 'pino';
import { query } from '../db.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Link Processing Service for Compile-Before-Send
 * Handles link tracking, UTM policies, and do-not-track rules
 */

const TRACKING_DOMAIN = process.env.COMM_TRACKING_DOMAIN || 'track.motorical.com';
const DO_NOT_TRACK_PATTERNS = [
  /^mailto:/i,
  /^tel:/i,
  /unsubscribe/i,
  /opt.?out/i,
  /#unsubscribe/i
];

export function shouldTrackLink(href) {
  if (!href || typeof href !== 'string') return false;
  
  // Skip relative links, anchors, and special schemes
  if (href.startsWith('#') || href.startsWith('/') || href.startsWith('javascript:')) return false;
  
  // Check do-not-track patterns
  return !DO_NOT_TRACK_PATTERNS.some(pattern => pattern.test(href));
}

export function parseUtmParams(url) {
  try {
    const urlObj = new URL(url);
    const utmParams = {};
    for (const [key, value] of urlObj.searchParams.entries()) {
      if (key.startsWith('utm_')) {
        utmParams[key] = value;
      }
    }
    return utmParams;
  } catch (e) {
    return {};
  }
}

export function applyUtmPolicy(originalUrl, policy = 'preserve', defaultUtms = {}) {
  try {
    const urlObj = new URL(originalUrl);
    const existingUtms = parseUtmParams(originalUrl);
    
    switch (policy) {
      case 'preserve':
        // Keep existing UTMs, don't add defaults
        return originalUrl;
        
      case 'append':
        // Add defaults only if UTM params don't exist
        for (const [key, value] of Object.entries(defaultUtms)) {
          if (!existingUtms[key] && !urlObj.searchParams.has(key)) {
            urlObj.searchParams.set(key, value);
          }
        }
        return urlObj.toString();
        
      case 'override':
        // Replace all UTMs with defaults
        // Remove existing UTM params
        for (const key of urlObj.searchParams.keys()) {
          if (key.startsWith('utm_')) {
            urlObj.searchParams.delete(key);
          }
        }
        // Add new UTMs
        for (const [key, value] of Object.entries(defaultUtms)) {
          urlObj.searchParams.set(key, value);
        }
        return urlObj.toString();
        
      default:
        return originalUrl;
    }
  } catch (e) {
    logger.warn({ originalUrl, error: e.message }, 'UTM policy application failed');
    return originalUrl;
  }
}

// Import the JWT token generator (will be used during send time with actual contact info)
// For compile time, we'll create a placeholder pattern that gets replaced during send
export function generateTrackingToken(campaignId, linkIndex, originalUrl) {
  const data = JSON.stringify({ campaignId, linkIndex, originalUrl, ts: Date.now() });
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

export function wrapLinkForTracking(originalUrl, campaignId, linkIndex) {
  // During compile: create placeholder that sender will replace with actual JWT token
  const placeholder = `TRACK_TOKEN_${campaignId}_${linkIndex}`;
  const encodedUrl = encodeURIComponent(originalUrl);
  return `https://${TRACKING_DOMAIN}/c/${placeholder}?url=${encodedUrl}`;
}

export async function storeLinkMap(campaignId, version, linkMap) {
  try {
    await query(
      'UPDATE comm_campaign_artifacts SET meta = meta || $1 WHERE campaign_id = $2 AND version = $3',
      [JSON.stringify({ linkMap }), campaignId, version]
    );
  } catch (error) {
    logger.error({ error: error.message, campaignId, version }, 'Failed to store link map');
  }
}

export function processHtmlLinks(html, options = {}) {
  const {
    campaignId,
    version = 1,
    utmPolicy = 'preserve',
    defaultUtms = {
      utm_source: 'email',
      utm_medium: 'campaign'
    }
  } = options;

  if (!html) return { processedHtml: html, linkMap: [], stats: { total: 0, tracked: 0, skipped: 0 } };

  const $ = cheerio.load(html);
  const linkMap = [];
  const stats = { total: 0, tracked: 0, skipped: 0 };
  let linkIndex = 0;

  $('a[href]').each((index, element) => {
    const $link = $(element);
    const originalHref = $link.attr('href');
    const linkText = $link.text().trim();
    
    stats.total++;

    if (!shouldTrackLink(originalHref)) {
      logger.debug({ href: originalHref, reason: 'do-not-track' }, 'Skipping link tracking');
      linkMap.push({
        index: linkIndex++,
        original: originalHref,
        processed: originalHref,
        text: linkText,
        tracked: false,
        reason: 'do-not-track'
      });
      stats.skipped++;
      return;
    }

    try {
      // Apply UTM policy
      const urlWithUtms = applyUtmPolicy(originalHref, utmPolicy, defaultUtms);
      
      // Wrap for tracking
      const trackedUrl = wrapLinkForTracking(urlWithUtms, campaignId, linkIndex);
      
      // Update the link in HTML
      $link.attr('href', trackedUrl);
      
      linkMap.push({
        index: linkIndex++,
        original: originalHref,
        processed: trackedUrl,
        finalDestination: urlWithUtms,
        text: linkText,
        tracked: true,
        utmPolicy,
        utmsApplied: parseUtmParams(urlWithUtms)
      });
      
      stats.tracked++;
      
    } catch (error) {
      logger.warn({ href: originalHref, error: error.message }, 'Link processing failed');
      linkMap.push({
        index: linkIndex++,
        original: originalHref,
        processed: originalHref,
        text: linkText,
        tracked: false,
        reason: 'processing-error',
        error: error.message
      });
      stats.skipped++;
    }
  });

  logger.info({ campaignId, stats }, 'Link processing completed');

  return {
    processedHtml: $.html(),
    linkMap,
    stats
  };
}

export default {
  processHtmlLinks,
  shouldTrackLink,
  applyUtmPolicy,
  parseUtmParams,
  storeLinkMap
};
