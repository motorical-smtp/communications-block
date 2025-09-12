import pino from 'pino';
import { query } from '../db.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Post-compile hook system for orchestrating follow-up tasks
 * after artifact and audience snapshot creation.
 */

const hooks = new Map();

export function registerHook(name, handler) {
  if (typeof handler !== 'function') {
    throw new Error(`Hook handler for '${name}' must be a function`);
  }
  hooks.set(name, handler);
  logger.info({ hookName: name }, 'Registered compile hook');
}

export async function executeHooks(event, context) {
  const results = [];
  for (const [name, handler] of hooks.entries()) {
    try {
      const startTime = Date.now();
      const result = await handler(event, context);
      const duration = Date.now() - startTime;
      results.push({ hook: name, success: true, duration, result });
      logger.info({ hookName: name, duration }, 'Hook executed successfully');
    } catch (error) {
      results.push({ hook: name, success: false, error: error.message });
      logger.error({ hookName: name, error: error.message }, 'Hook execution failed');
    }
  }
  return results;
}

// Built-in hooks for compile orchestration

registerHook('audit-log', async (event, context) => {
  const { type, campaignId, tenantId, version, totalRecipients } = context;
  logger.info({
    event: type,
    campaignId,
    tenantId,
    version,
    totalRecipients,
    timestamp: new Date().toISOString()
  }, 'Compile audit entry');
  return { logged: true };
});

registerHook('metrics-emit', async (event, context) => {
  const { type, campaignId, version, totalRecipients } = context;
  // Emit metrics (placeholder - could integrate with StatsD, Prometheus, etc.)
  logger.info({
    metric: 'compile.completed',
    campaignId,
    version,
    recipients: totalRecipients,
    tags: { tenant_id: context.tenantId }
  }, 'Compile metrics emitted');
  return { metricsEmitted: true };
});

// HTML-to-text generation hook
registerHook('html-to-text-generation', async (event, context) => {
  const { campaignId, version, artifact } = context;
  
  try {
    if (!artifact?.htmlCompiled) {
      return { textGenerated: false, reason: 'no-html' };
    }

    // Import HTML-to-text processor
    const { htmlToText } = await import('./html-to-text.js');
    
    // Generate meaningful text from HTML
    const generatedText = htmlToText(artifact.htmlCompiled);
    
    if (generatedText && generatedText.length > 20) {
      // Update the artifact with generated text
      await query(
        'UPDATE comm_campaign_artifacts SET text_compiled = $1 WHERE campaign_id = $2 AND version = $3',
        [generatedText, campaignId, version]
      );
      
      logger.info({
        campaignId,
        textLength: generatedText.length,
        originalLength: artifact.htmlCompiled.length
      }, 'HTML-to-text generation completed');
      
      return {
        textGenerated: true,
        textLength: generatedText.length,
        compressionRatio: Math.round((generatedText.length / artifact.htmlCompiled.length) * 100)
      };
    } else {
      logger.warn({ campaignId, generatedLength: generatedText?.length || 0 }, 'Generated text too short, keeping original');
      return { textGenerated: false, reason: 'text-too-short' };
    }
    
  } catch (error) {
    logger.error({ campaignId, error: error.message }, 'HTML-to-text generation failed');
    return { textGenerated: false, error: error.message };
  }
});

// Security validation hook with size/node/link caps (triggered on both validation and completion events)
registerHook('security-validation', async (event, context) => {
  const { artifact, campaignId } = context;
  const warnings = [];
  const errors = [];
  
  try {
    if (!artifact?.htmlCompiled) {
      return { validated: true, warnings, errors };
    }

    const html = artifact.htmlCompiled;
    
    // Import cheerio for DOM analysis
    const cheerio = await import('cheerio');
    const $ = cheerio.load(html);
    
    // Security limits (configurable)
    const limits = {
      maxHtmlSize: 500 * 1024,        // 500KB max HTML size
      maxDomNodes: 2000,              // 2000 max DOM nodes
      maxLinks: 100,                  // 100 max links
      maxImages: 50,                  // 50 max images
      maxTextLength: 100 * 1024       // 100KB max text content
    };
    
    // 1. HTML size validation
    const htmlSize = Buffer.byteLength(html, 'utf8');
    if (htmlSize > limits.maxHtmlSize) {
      errors.push({
        type: 'html_size_exceeded',
        message: `HTML size (${Math.round(htmlSize/1024)}KB) exceeds limit (${Math.round(limits.maxHtmlSize/1024)}KB)`,
        limit: limits.maxHtmlSize,
        actual: htmlSize
      });
    } else if (htmlSize > limits.maxHtmlSize * 0.8) {
      warnings.push({
        type: 'html_size_warning',
        message: `HTML size (${Math.round(htmlSize/1024)}KB) is approaching limit (${Math.round(limits.maxHtmlSize/1024)}KB)`,
        limit: limits.maxHtmlSize,
        actual: htmlSize
      });
    }
    
    // 2. DOM node count validation
    const nodeCount = $('*').length;
    if (nodeCount > limits.maxDomNodes) {
      errors.push({
        type: 'dom_nodes_exceeded',
        message: `DOM node count (${nodeCount}) exceeds limit (${limits.maxDomNodes})`,
        limit: limits.maxDomNodes,
        actual: nodeCount
      });
    } else if (nodeCount > limits.maxDomNodes * 0.8) {
      warnings.push({
        type: 'dom_nodes_warning',
        message: `DOM node count (${nodeCount}) is approaching limit (${limits.maxDomNodes})`,
        limit: limits.maxDomNodes,
        actual: nodeCount
      });
    }
    
    // 3. Link count validation
    const linkCount = $('a[href]').length;
    if (linkCount > limits.maxLinks) {
      errors.push({
        type: 'links_exceeded',
        message: `Link count (${linkCount}) exceeds limit (${limits.maxLinks})`,
        limit: limits.maxLinks,
        actual: linkCount
      });
    } else if (linkCount > limits.maxLinks * 0.8) {
      warnings.push({
        type: 'links_warning',
        message: `Link count (${linkCount}) is approaching limit (${limits.maxLinks})`,
        limit: limits.maxLinks,
        actual: linkCount
      });
    }
    
    // 4. Image count validation
    const imageCount = $('img').length;
    if (imageCount > limits.maxImages) {
      warnings.push({
        type: 'images_warning',
        message: `Image count (${imageCount}) exceeds recommended limit (${limits.maxImages})`,
        limit: limits.maxImages,
        actual: imageCount
      });
    }
    
    // 5. Text content validation
    const textLength = $.text().length;
    if (textLength > limits.maxTextLength) {
      warnings.push({
        type: 'text_length_warning',
        message: `Text content (${Math.round(textLength/1024)}KB) exceeds recommended limit (${Math.round(limits.maxTextLength/1024)}KB)`,
        limit: limits.maxTextLength,
        actual: textLength
      });
    }
    
    // 6. Suspicious patterns detection
    const suspiciousPatterns = [
      { pattern: /<script/gi, type: 'script_tags', message: 'Script tags detected (will be removed)' },
      { pattern: /javascript:/gi, type: 'javascript_urls', message: 'JavaScript URLs detected' },
      { pattern: /on\w+\s*=/gi, type: 'event_handlers', message: 'Event handlers detected (will be removed)' }
    ];
    
    suspiciousPatterns.forEach(({ pattern, type, message }) => {
      const matches = html.match(pattern);
      if (matches) {
        warnings.push({
          type,
          message: `${message} (${matches.length} instances)`,
          count: matches.length
        });
      }
    });
    
    const validated = errors.length === 0;
    
    logger.info({
      campaignId,
      validated,
      htmlSize,
      nodeCount,
      linkCount,
      imageCount,
      textLength,
      warningCount: warnings.length,
      errorCount: errors.length
    }, 'Security validation completed');
    
    return { validated, warnings, errors, metrics: { htmlSize, nodeCount, linkCount, imageCount, textLength } };
    
  } catch (error) {
    logger.error({ campaignId, error: error.message }, 'Security validation failed');
    errors.push({
      type: 'validation_error',
      message: `Security validation failed: ${error.message}`
    });
    return { validated: false, warnings, errors };
  }
});

// Link tracking and UTM processing hook
registerHook('link-processing', async (event, context) => {
  const { campaignId, version, artifact, campaign } = context;
  
  try {
    // Import link processor (dynamic to avoid startup issues)
    const { processHtmlLinks, storeLinkMap } = await import('./link-processor.js');
    
    if (!artifact?.htmlCompiled) {
      return { linksProcessed: 0, trackingApplied: false, reason: 'no-html' };
    }

    // Determine UTM policy and parameters based on Google Analytics settings
    const gaSettings = campaign?.google_analytics || { enabled: false };
    
    let utmPolicy = 'preserve'; // Default: preserve customer's existing UTMs
    let defaultUtms = {
      utm_source: 'email',
      utm_medium: 'motorical_campaign',
      utm_campaign: `campaign_${campaignId.substring(0, 8)}`
    };
    
    // If GA is enabled, use SendGrid-style behavior
    if (gaSettings.enabled) {
      utmPolicy = 'append'; // Add GA UTMs where missing, preserve existing
      defaultUtms = {
        utm_source: gaSettings.utm_source || 'motorical_email',
        utm_medium: gaSettings.utm_medium || 'email',
        utm_campaign: gaSettings.utm_campaign || `campaign_${campaignId.substring(0, 8)}`,
        utm_content: gaSettings.utm_content || 'email_link'
      };
      
      // Add utm_term if provided
      if (gaSettings.utm_term) {
        defaultUtms.utm_term = gaSettings.utm_term;
      }
    }

    // Process links with determined policy
    const result = await processHtmlLinks(artifact.htmlCompiled, {
      campaignId,
      version,
      utmPolicy,
      defaultUtms
    });

    // Store the link map in the artifact metadata
    if (result.linkMap.length > 0) {
      await storeLinkMap(campaignId, version, result.linkMap);
    }

    logger.info({
      campaignId,
      stats: result.stats,
      linksFound: result.linkMap.length
    }, 'Link processing completed');

    return {
      linksProcessed: result.stats.tracked,
      linksSkipped: result.stats.skipped,
      totalLinks: result.stats.total,
      trackingApplied: result.stats.tracked > 0,
      linkMap: result.linkMap
    };
    
  } catch (error) {
    logger.error({ campaignId, error: error.message }, 'Link processing failed');
    return { 
      linksProcessed: 0, 
      trackingApplied: false, 
      error: error.message 
    };
  }
});

export default {
  registerHook,
  executeHooks
};
