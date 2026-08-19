/**
 * Cache & Meta Logger Module
 * Provides detailed logging for cache operations, meta fetching, and performance tracking.
 * 
 * Log Levels: debug < info < warn < error
 * Set via LOG_LEVEL env var (default: 'debug')
 */

const LOG_LEVEL = (process.env.LOG_LEVEL || 'debug').toLowerCase();
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LOG_LEVELS[LOG_LEVEL] ?? 0;

// Stats tracking
const stats = {
  ramHits: 0,
  ramMisses: 0,
  redisHits: 0,
  redisMisses: 0,
  mongoHits: 0,
  mongoMisses: 0,
  metaRequests: 0,
  catalogRequests: 0,
  totalResponseTimeMs: 0,
  requestCount: 0,
  slowRequests: 0, // > 2000ms
  errors: 0,
  startedAt: Date.now(),
};

// --- Logging functions ---

function shouldLog(level) {
  return (LOG_LEVELS[level] ?? 0) >= currentLevel;
}

function formatMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function logDebug(tag, message, data) {
  if (!shouldLog('debug')) return;
  const prefix = `[${tag}]`;
  if (data !== undefined) {
    console.log(prefix, message, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(prefix, message);
  }
}

function logInfo(tag, message, data) {
  if (!shouldLog('info')) return;
  const prefix = `[${tag}]`;
  if (data !== undefined) {
    console.log(prefix, message, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(prefix, message);
  }
}

function logWarn(tag, message, data) {
  if (!shouldLog('warn')) return;
  const prefix = `[${tag}]`;
  if (data !== undefined) {
    console.warn(prefix, message, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.warn(prefix, message);
  }
}

function logError(tag, message, data) {
  if (!shouldLog('error')) return;
  const prefix = `[${tag}]`;
  if (data !== undefined) {
    console.error(prefix, message, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.error(prefix, message);
  }
}

// --- Performance timer ---

function startTimer() {
  return process.hrtime.bigint();
}

function endTimer(start) {
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // nanoseconds to ms
  return Math.round(elapsed * 100) / 100; // round to 2 decimal places
}

// --- Cache event loggers ---

function logCacheHit(tier, key, elapsedMs) {
  stats[`${tier}Hits`]++;
  logDebug('Cache', `✅ HIT ${tier.toUpperCase()} key="${truncateKey(key)}" (${formatMs(elapsedMs)})`);
}

function logCacheMiss(tier, key, elapsedMs) {
  stats[`${tier}Misses`]++;
  logDebug('Cache', `❌ MISS ${tier.toUpperCase()} key="${truncateKey(key)}" (${formatMs(elapsedMs)})`);
}

function logCacheSet(tier, key, ttl) {
  logDebug('Cache', `💾 SET ${tier.toUpperCase()} key="${truncateKey(key)}" ttl=${ttl}s`);
}

function logCacheError(tier, operation, key, error) {
  stats.errors++;
  logError('Cache', `🔴 ERROR ${tier.toUpperCase()} ${operation} key="${truncateKey(key)}": ${error.message || error}`);
}

// --- Meta event loggers ---

function logMetaRequest(type, tmdbId, language, source) {
  stats.metaRequests++;
  logDebug('Meta', `📥 REQUEST ${type}/${tmdbId} lang=${language} source=${source}`);
}

function logMetaResponse(type, tmdbId, elapsedMs, fromCache) {
  stats.requestCount++;
  stats.totalResponseTimeMs += elapsedMs;
  if (elapsedMs > 2000) stats.slowRequests++;

  const icon = fromCache ? '⚡' : '🌐';
  const label = fromCache ? 'FROM CACHE' : 'FROM API';
  const level = elapsedMs > 2000 ? 'warn' : 'debug';

  const msg = `${icon} RESPONSE ${type}/${tmdbId} ${label} (${formatMs(elapsedMs)})`;
  if (level === 'warn') {
    logWarn('Meta', `🐢 SLOW ${msg}`);
  } else {
    logDebug('Meta', msg);
  }
}

// --- Catalog event loggers ---

function logCatalogRequest(type, catalogId, page, genre) {
  stats.catalogRequests++;
  logDebug('Catalog', `📥 REQUEST ${type}/${catalogId} page=${page} genre=${genre || 'all'}`);
}

function logCatalogResponse(type, catalogId, count, elapsedMs) {
  stats.requestCount++;
  stats.totalResponseTimeMs += elapsedMs;
  if (elapsedMs > 2000) stats.slowRequests++;

  const level = elapsedMs > 2000 ? 'warn' : 'debug';
  const msg = `📤 RESPONSE ${type}/${catalogId} items=${count} (${formatMs(elapsedMs)})`;
  if (level === 'warn') {
    logWarn('Catalog', `🐢 SLOW ${msg}`);
  } else {
    logDebug('Catalog', msg);
  }
}

// --- Route timing ---

function logRouteStart(route, params) {
  logDebug('Route', `➡️  ${route}`, params);
}

function logRouteEnd(route, elapsedMs, statusCode) {
  const level = elapsedMs > 3000 ? 'warn' : 'debug';
  const msg = `⬅️  ${route} status=${statusCode || 200} (${formatMs(elapsedMs)})`;
  if (level === 'warn') {
    logWarn('Route', `🐢 SLOW ${msg}`);
  } else {
    logDebug('Route', msg);
  }
}

// --- Stats ---

function getStats() {
  const uptimeMs = Date.now() - stats.startedAt;
  const avgResponseMs = stats.requestCount > 0
    ? Math.round(stats.totalResponseTimeMs / stats.requestCount)
    : 0;

  const ramTotal = stats.ramHits + stats.ramMisses;
  const redisTotal = stats.redisHits + stats.redisMisses;
  const mongoTotal = stats.mongoHits + stats.mongoMisses;

  return {
    uptime: formatMs(uptimeMs),
    logLevel: LOG_LEVEL,
    cache: {
      ram: {
        hits: stats.ramHits,
        misses: stats.ramMisses,
        total: ramTotal,
        hitRate: ramTotal > 0 ? `${((stats.ramHits / ramTotal) * 100).toFixed(1)}%` : 'N/A',
      },
      redis: {
        hits: stats.redisHits,
        misses: stats.redisMisses,
        total: redisTotal,
        hitRate: redisTotal > 0 ? `${((stats.redisHits / redisTotal) * 100).toFixed(1)}%` : 'N/A',
      },
      mongo: {
        hits: stats.mongoHits,
        misses: stats.mongoMisses,
        total: mongoTotal,
        hitRate: mongoTotal > 0 ? `${((stats.mongoHits / mongoTotal) * 100).toFixed(1)}%` : 'N/A',
      },
    },
    requests: {
      meta: stats.metaRequests,
      catalog: stats.catalogRequests,
      total: stats.requestCount,
      avgResponseMs,
      slowRequests: stats.slowRequests,
      errors: stats.errors,
    },
  };
}

function logStatsSummary() {
  if (!shouldLog('info')) return;
  const s = getStats();
  console.log('\n📊 ═══════════ CACHE & META STATS ═══════════');
  console.log(`   Uptime: ${s.uptime} | Log Level: ${s.logLevel}`);
  console.log(`   RAM   → Hits: ${s.cache.ram.hits} | Misses: ${s.cache.ram.misses} | Rate: ${s.cache.ram.hitRate}`);
  console.log(`   Redis → Hits: ${s.cache.redis.hits} | Misses: ${s.cache.redis.misses} | Rate: ${s.cache.redis.hitRate}`);
  console.log(`   Mongo → Hits: ${s.cache.mongo.hits} | Misses: ${s.cache.mongo.misses} | Rate: ${s.cache.mongo.hitRate}`);
  console.log(`   Requests: ${s.requests.total} (Meta: ${s.requests.meta} | Catalog: ${s.requests.catalog})`);
  console.log(`   Avg Response: ${s.requests.avgResponseMs}ms | Slow(>2s): ${s.requests.slowRequests} | Errors: ${s.requests.errors}`);
  console.log('═════════════════════════════════════════════\n');
}

// Auto-log stats summary every 5 minutes
const STATS_INTERVAL = parseInt(process.env.STATS_INTERVAL_MS, 10) || 5 * 60 * 1000;
let statsInterval = null;

function startStatsReporting() {
  if (statsInterval) return;
  statsInterval = setInterval(logStatsSummary, STATS_INTERVAL);
  // Don't prevent process from exiting
  if (statsInterval.unref) statsInterval.unref();
  logInfo('Logger', `📊 Stats reporting started (every ${formatMs(STATS_INTERVAL)})`);
}

function stopStatsReporting() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

// --- Helpers ---

function truncateKey(key) {
  if (!key || key.length <= 60) return key;
  return key.substring(0, 57) + '...';
}

// Start stats reporting on module load
startStatsReporting();

module.exports = {
  // Core logging
  logDebug,
  logInfo,
  logWarn,
  logError,
  // Timer
  startTimer,
  endTimer,
  // Cache events
  logCacheHit,
  logCacheMiss,
  logCacheSet,
  logCacheError,
  // Meta events
  logMetaRequest,
  logMetaResponse,
  // Catalog events
  logCatalogRequest,
  logCatalogResponse,
  // Route events
  logRouteStart,
  logRouteEnd,
  // Stats
  getStats,
  logStatsSummary,
  startStatsReporting,
  stopStatsReporting,
};
