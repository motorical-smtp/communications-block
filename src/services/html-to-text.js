import * as cheerio from 'cheerio';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * HTML-to-Text Conversion Service
 * Generates meaningful plaintext from customer HTML while preserving structure and content
 */

export function htmlToText(html) {
  if (!html || typeof html !== 'string') {
    return '';
  }

  try {
    const $ = cheerio.load(html);
    
    // Remove style, script, and other non-content elements
    $('style, script, head, meta, title').remove();
    
    // Remove hidden or irrelevant elements
    $('[style*="display:none"], [style*="display: none"]').remove();
    $('.hidden, .sr-only, [aria-hidden="true"]').remove();
    
    let result = [];
    
    // Extract content in a structured way
    function extractText($element) {
      const text = [];
      
      $element.contents().each((index, node) => {
        if (node.type === 'text') {
          const textContent = $(node).text().trim();
          if (textContent) {
            text.push(textContent);
          }
        } else if (node.type === 'tag') {
          const $node = $(node);
          const tagName = node.tagName.toLowerCase();
          
          if (tagName === 'h1' || tagName === 'h2' || tagName === 'h3' || tagName === 'h4' || tagName === 'h5' || tagName === 'h6') {
            const headerText = $node.text().trim();
            if (headerText) {
              text.push('\n' + headerText.toUpperCase());
              text.push('='.repeat(headerText.length));
            }
          } else if (tagName === 'p' || tagName === 'div') {
            const paragraphText = $node.text().trim();
            if (paragraphText && paragraphText.length > 3) {
              text.push('\n' + paragraphText);
            }
          } else if (tagName === 'a') {
            const linkText = $node.text().trim();
            const href = $node.attr('href');
            if (linkText && href && !href.startsWith('#') && !href.includes('{{')) {
              // Only show URL for external links, skip tracking and merge tag URLs
              if (href.startsWith('http') && !href.includes('track.motorical.com')) {
                text.push(`${linkText} (${href})`);
              } else {
                text.push(linkText);
              }
            } else if (linkText) {
              text.push(linkText);
            }
          } else if (tagName === 'img') {
            const alt = $node.attr('alt');
            if (alt && alt.trim()) {
              text.push(`[${alt.trim()}]`);
            }
          } else if (tagName === 'br') {
            text.push('\n');
          } else {
            // Recursively process other elements
            const childText = extractText($node);
            if (childText.length > 0) {
              text.push(...childText);
            }
          }
        }
      });
      
      return text;
    }
    
    // Extract all text from body or root
    const body = $('body').length > 0 ? $('body') : $.root();
    const allText = extractText(body);
    
    // Join and clean up the text
    let finalText = allText
      .join(' ')
      .replace(/\s+/g, ' ')          // Normalize whitespace
      .replace(/\n /g, '\n')         // Remove spaces after newlines
      .replace(/\n{3,}/g, '\n\n')    // Limit consecutive newlines
      .trim();
    
    // Ensure we have meaningful content
    if (!finalText || finalText.length < 20) {
      // Fallback: just get the visible text
      finalText = $.text()
        .replace(/\s+/g, ' ')
        .trim();
    }
    
    // Add unsubscribe if original HTML had it but our extraction missed it
    if (html.includes('{{unsubscribe_url}}') && !finalText.includes('{{unsubscribe_url}}')) {
      finalText += '\n\nUnsubscribe: {{unsubscribe_url}}';
    }
    
    return finalText;

  } catch (error) {
    logger.warn({ error: error.message }, 'HTML-to-text conversion failed');
    // Fallback: strip HTML tags and normalize whitespace
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

export function generateTextFromTemplate(template, options = {}) {
  const { preserveUnsubscribe = true, addFooter = true } = options;
  
  let text = htmlToText(template.body_html || '');
  
  // Ensure unsubscribe link is preserved if not already present
  if (preserveUnsubscribe && template.body_html?.includes('{{unsubscribe_url}}')) {
    if (!text.includes('{{unsubscribe_url}}')) {
      text += '\n\nUnsubscribe: {{unsubscribe_url}}';
    }
  }
  
  // Add basic footer if text is very short
  if (addFooter && text.length < 50) {
    text += '\n\nSent via email marketing platform';
  }
  
  return text;
}

export default {
  htmlToText,
  generateTextFromTemplate
};
