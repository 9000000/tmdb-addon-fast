/**
 * Utility to get the host URL for the addon.
 * Supports multiple sources with fallback:
 * 1. HOST_NAME environment variable (manual config)
 * 2. VERCEL_URL environment variable (auto-detected on Vercel)
 * 3. Request headers (for dynamic detection)
 */

/**
 * Get the base host URL from environment variables
 * @returns {string} The host URL or empty string
 */
function getHostFromEnv() {
  // Priority 1: Explicit HOST_NAME
  if (process.env.HOST_NAME) {
    return process.env.HOST_NAME.replace(/\/$/, '');
  }

  // Priority 2: Vercel auto-detected URL
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  // Priority 3: Vercel branch URL (for preview deployments)
  if (process.env.VERCEL_BRANCH_URL) {
    return `https://${process.env.VERCEL_BRANCH_URL}`;
  }

  return '';
}

/**
 * Get the host URL from request headers (for dynamic detection)
 * @param {Object} req - Express request object
 * @returns {string} The detected host URL
 */
function getHostFromRequest(req) {
  if (!req) return getHostFromEnv();

  // Check for forwarded headers (reverse proxy support)
  let protocol = req.protocol;
  
  // Handle reverse proxy headers
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedProto) {
    protocol = forwardedProto.split(',')[0].trim();
  }

  // Ensure HTTPS for production/Vercel
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    protocol = 'https';
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host || req.hostname;

  if (host) {
    return `${protocol}://${host}`;
  }

  return getHostFromEnv();
}

/**
 * Get the full host URL with fallback chain
 * @param {Object} [req] - Optional Express request object
 * @returns {string} The host URL
 */
function getHostUrl(req) {
  // Try request detection first
  if (req) {
    return getHostFromRequest(req);
  }

  // Try environment variables
  const envHost = getHostFromEnv();
  if (envHost) {
    return envHost;
  }

  // Default fallback for local development
  const port = process.env.PORT || 1337;
  return `http://localhost:${port}`;
}

module.exports = {
  getHostUrl,
  getHostFromEnv,
  getHostFromRequest
};
