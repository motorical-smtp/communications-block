import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * CSV Injection patterns to detect and block
 * These patterns can be used to execute formulas in Excel/Google Sheets
 */
const CSV_INJECTION_PATTERNS = [
  // Formula injection patterns
  /^[\s]*[=@+\-]/i,  // Starts with =, @, +, or -
  /^[\s]*cmd[\s]*\|/i,  // cmd| command injection
  /^[\s]*powershell[\s]*\|/i,  // PowerShell injection
  /^[\s]*\||&/i,  // Pipe or ampersand (command chaining)
  /^[\s]*`/i,  // Backtick (command substitution)
  /^[\s]*\$\(/i,  // Command substitution $(...)
  /^[\s]*<[a-z]+>/i,  // HTML-like tags that could be interpreted
  /^[\s]*\x00/i,  // Null byte injection
];

/**
 * Dangerous formula functions that could be exploited
 */
const DANGEROUS_FORMULAS = [
  'HYPERLINK',
  'WEBSERVICE',
  'IMPORTXML',
  'IMPORTDATA',
  'IMPORTHTML',
  'IMPORTFEED',
  'FILTERXML',
  'ENCODEURL',
  'WEBSERVICE',
];

/**
 * Validates CSV cell content for injection patterns
 * @param {string} value - Cell value to validate
 * @returns {Object} { safe: boolean, reason?: string, pattern?: string }
 */
export function validateCsvCell(value) {
  if (!value || typeof value !== 'string') {
    return { safe: true };
  }

  const trimmed = value.trim();

  // Check for injection patterns
  for (const pattern of CSV_INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        safe: false,
        reason: 'csv_injection_pattern',
        pattern: pattern.toString(),
        value: trimmed.substring(0, 50) // First 50 chars for logging
      };
    }
  }

  // Check for dangerous formula functions (case-insensitive)
  const upperValue = trimmed.toUpperCase();
  for (const formula of DANGEROUS_FORMULAS) {
    if (upperValue.includes(formula)) {
      // Allow if it's part of a longer word (not standalone)
      const regex = new RegExp(`\\b${formula}\\b`, 'i');
      if (regex.test(trimmed)) {
        return {
          safe: false,
          reason: 'dangerous_formula',
          pattern: formula,
          value: trimmed.substring(0, 50)
        };
      }
    }
  }

  return { safe: true };
}

/**
 * Validates all cells in a CSV row
 * @param {Object} row - CSV row object
 * @returns {Object} { safe: boolean, violations: Array }
 */
export function validateCsvRow(row) {
  const violations = [];

  for (const [key, value] of Object.entries(row)) {
    const validation = validateCsvCell(String(value || ''));
    if (!validation.safe) {
      violations.push({
        column: key,
        value: validation.value,
        reason: validation.reason,
        pattern: validation.pattern
      });
    }
  }

  return {
    safe: violations.length === 0,
    violations
  };
}

/**
 * Validates entire CSV data
 * @param {Array} rows - Array of CSV row objects
 * @param {number} maxViolations - Maximum violations before rejecting entire file
 * @returns {Object} { safe: boolean, violations: Array, violationCount: number }
 */
export function validateCsvData(rows, maxViolations = 10) {
  const allViolations = [];
  let rowIndex = 0;

  for (const row of rows) {
    const rowValidation = validateCsvRow(row);
    if (!rowValidation.safe) {
      rowValidation.violations.forEach(v => {
        allViolations.push({
          ...v,
          row: rowIndex + 1 // 1-indexed for user-friendly reporting
        });
      });
    }
    rowIndex++;

    // Early exit if too many violations
    if (allViolations.length > maxViolations) {
      break;
    }
  }

  return {
    safe: allViolations.length === 0,
    violations: allViolations.slice(0, maxViolations), // Limit returned violations
    violationCount: allViolations.length,
    totalRows: rows.length
  };
}

