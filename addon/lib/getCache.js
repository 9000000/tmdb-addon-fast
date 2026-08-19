const { createCache } = require('cache-manager');
const Redis = require('ioredis');

const GLOBAL_KEY_PREFIX = 'tmdb-addon';

// Cache logging verbosity: 'verbose' = log every hit/miss, 'summary' = periodic stats, 'off' = silent
const CACHE_LOG_LEVEL = (process.env.CACHE_LOG_LEVEL || 'verbose').toLowerCase();
const isVerbose = CACHE_LOG_LEVEL === 'verbose';
const isSummary = CACHE_LOG_LEVEL === 'summary' || isVerbose;

// Stats counters for summary mode
const cacheStats = {
  redisHit: 0, redisMiss: 0, redisError: 0,
  wrapHit: 0, wrapMiss: 0, wrapError: 0,
  redisSetOk: 0, redisSetFail: 0,
  timeoutCount: 0,
  startTime: Date.now()
};

// Print cache stats every 60 seconds when summary mode is on
if (isSummary) {
  setInterval(() => {
    const uptime = ((Date.now() - cacheStats.startTime) / 1000).toFixed(0);
    const total = cacheStats.wrapHit + cacheStats.wrapMiss;
    const hitRate = total > 0 ? ((cacheStats.wrapHit / total) * 100).toFixed(1) : '0.0';
    console.log(`[Cache Stats] uptime=${uptime}s | wrap: hit=${cacheStats.wrapHit} miss=${cacheStats.wrapMiss} err=${cacheStats.wrapError} hitRate=${hitRate}% | redis: hit=${cacheStats.redisHit} miss=${cacheStats.redisMiss} err=${cacheStats.redisError} set=${cacheStats.redisSetOk} setFail=${cacheStats.redisSetFail} | timeouts=${cacheStats.timeoutCount}`);
  }, 60_000).unref();
}
const META_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|meta`;
const CATALOG_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|catalog`;

function parsePositiveInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

// TTL của cache-manager v7 sử dụng mili-giây (ms).
// Nhận vào giây từ env rồi nhân 1000 sang mili-giây để tương thích cấu hình cũ.
const META_TTL = parsePositiveInt(process.env.META_TTL, 7 * 24 * 60 * 60) * 1000;
const CATALOG_TTL = parsePositiveInt(process.env.CATALOG_TTL, 24 * 60 * 60) * 1000;
const MEMORY_CACHE_MAX_KEYS = parsePositiveInt(process.env.MEMORY_CACHE_MAX_KEYS, 5000);

const RAM_META_TTL = parsePositiveInt(process.env.RAM_META_TTL, 3600) * 1000;
const RAM_META_MAX_KEYS = parsePositiveInt(process.env.RAM_META_MAX_KEYS, 2000);
const RAM_IMDB_TTL = parsePositiveInt(process.env.RAM_IMDB_TTL, 86400) * 1000;
const RAM_IMDB_MAX_KEYS = parsePositiveInt(process.env.RAM_IMDB_MAX_KEYS, 5000);
const RAM_AGE_RATING_TTL = parsePositiveInt(process.env.RAM_AGE_RATING_TTL, 3600) * 1000;
const RAM_AGE_RATING_MAX_KEYS = parsePositiveInt(process.env.RAM_AGE_RATING_MAX_KEYS, 5000);
const RAM_USER_COUNTER_TTL = parsePositiveInt(process.env.RAM_USER_COUNTER_TTL, 86400) * 1000;
const RAM_USER_COUNTER_MAX_KEYS = parsePositiveInt(process.env.RAM_USER_COUNTER_MAX_KEYS, 100000);

const NO_CACHE = process.env.NO_CACHE === 'true' || process.env.NO_CACHE === '1';
const REDIS_URL = process.env.REDIS_URL;

// Hỗ trợ Redis Cluster
const REDIS_IS_CLUSTER = process.env.REDIS_IS_CLUSTER === 'true';
const REDIS_CLUSTER_NODES = process.env.REDIS_CLUSTER_NODES
  ? process.env.REDIS_CLUSTER_NODES.split(',').map(node => {
      const [host, port] = node.trim().split(':');
      return { host, port: parseInt(port, 10) || 6379 };
    })
  : [];

let redisInstance = null;

console.log('[Cache] Configuration:', {
  REDIS_URL: REDIS_URL ? `${REDIS_URL.substring(0, 20)}...` : 'not set',
  REDIS_IS_CLUSTER: REDIS_IS_CLUSTER,
  NO_CACHE: NO_CACHE,
  META_TTL: (META_TTL / 1000) + 's',
  CATALOG_TTL: (CATALOG_TTL / 1000) + 's'
});

// Khởi tạo các RAM cache chuyên dụng đồng bộ trực tiếp bằng createCache (v7)
const ramMetaCache = createCache({ ttl: RAM_META_TTL, max: RAM_META_MAX_KEYS });
const ramImdbCache = createCache({ ttl: RAM_IMDB_TTL, max: RAM_IMDB_MAX_KEYS });
const ramAgeRatingCache = createCache({ ttl: RAM_AGE_RATING_TTL, max: RAM_AGE_RATING_MAX_KEYS });
const ramUserCounterCache = createCache({ ttl: RAM_USER_COUNTER_TTL, max: RAM_USER_COUNTER_MAX_KEYS });

// Khởi tạo Redis client
function getRedisClient() {
  if (NO_CACHE) return null;
  if (redisInstance) return redisInstance;

  const defaultRedisOptions = {
    maxRetriesPerRequest: 2,
    retryDelayOnFailover: 100,
    lazyConnect: false,
    enableOfflineQueue: true, // Allow commands to wait briefly during reconnection
    enableReadyCheck: true,
    connectTimeout: 8000,
    commandTimeout: 2000, // 2s max per Redis command
    keepAlive: 30000, // 30s TCP keepalive
  };

  if (REDIS_IS_CLUSTER && REDIS_CLUSTER_NODES.length > 0) {
    console.log('[Cache] Initializing Redis CLUSTER client...');
    redisInstance = new Redis.Cluster(REDIS_CLUSTER_NODES, {
      redisOptions: {
        ...defaultRedisOptions,
        tls: process.env.REDIS_USE_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
      },
      clusterRetryStrategy: (times) => Math.min(times * 100, 2000)
    });
  } else if (REDIS_URL) {
    console.log('[Cache] Initializing Redis Single Node client...');
    const isUpstash = REDIS_URL.includes('upstash.io');
    const usesTLS = REDIS_URL.startsWith('rediss://');

    const redisOptions = {
      ...defaultRedisOptions,
      tls: (isUpstash || usesTLS) ? { rejectUnauthorized: false } : undefined,
    };
    redisInstance = new Redis(REDIS_URL, redisOptions);
  }

  if (redisInstance) {
    redisInstance.on('connect', () => console.log('[Redis] Connected successfully'));
    redisInstance.on('ready', () => console.log('[Redis] Ready to accept commands'));
    redisInstance.on('error', (err) => console.error('[Redis] Connection error:', err.message));
  }

  return redisInstance;
}

// Helper: Timeout protection for async operations
function withTimeout(promise, ms, fallbackValue, label = '') {
  let timer;
  let timedOut = false;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      cacheStats.timeoutCount++;
      console.warn(`[Cache Timeout] ${label} exceeded ${ms}ms, returning fallback`);
      resolve(fallbackValue);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// Khởi tạo cache-manager chính đồng bộ (v7)
function initiateCache() {
  if (NO_CACHE) {
    console.log('[Cache] NO_CACHE is enabled, caching disabled');
    return null;
  }

  const redisClient = getRedisClient();

  if (redisClient) {
    console.log('[Cache] Creating Redis Custom Store for cache-manager v7 with timeout protection...');
    const redisStore = {
      async get(key, options) {
        const t0 = Date.now();
        try {
          const val = await withTimeout(redisClient.get(key), 1500, null, `GET ${key}`);
          const latency = Date.now() - t0;

          if (!val) {
            cacheStats.redisMiss++;
            if (isVerbose) console.log(`[Redis GET] MISS key=${key} latency=${latency}ms`);
            return undefined;
          }

          cacheStats.redisHit++;
          if (isVerbose) console.log(`[Redis GET] HIT key=${key} latency=${latency}ms size=${val.length}B`);

          const parsed = JSON.parse(val);
          // Check if value is wrapped with { value, expires } for cache-manager wrap compat
          const hasWrap = parsed && typeof parsed === 'object' && 'value' in parsed && 'expires' in parsed;
          const expires = hasWrap ? parsed.expires : (Date.now() + META_TTL);
          const value = hasWrap ? parsed.value : parsed;

          if (options?.raw) {
            return { value, expires };
          }
          return value;
        } catch (err) {
          cacheStats.redisError++;
          console.error(`[Redis GET] ERROR key=${key} latency=${Date.now() - t0}ms err=${err.message}`);
          return undefined;
        }
      },
      async set(key, value, ttl) {
        const t0 = Date.now();
        try {
          // Normalize TTL from wrap (ms as number) or direct call (object like { ttl: seconds })
          let msTTL = META_TTL;
          if (typeof ttl === 'number') {
            msTTL = ttl;
          } else if (ttl && typeof ttl === 'object' && typeof ttl.ttl === 'number') {
            msTTL = ttl.ttl * 1000;
          }

          const expires = Date.now() + msTTL;
          const payload = JSON.stringify({ value, expires });

          const setPromise = msTTL > 0
            ? redisClient.set(key, payload, 'PX', msTTL)
            : redisClient.set(key, payload);

          await withTimeout(setPromise, 1500, null, `SET ${key}`);
          cacheStats.redisSetOk++;
          if (isVerbose) console.log(`[Redis SET] OK key=${key} ttl=${(msTTL / 1000).toFixed(0)}s size=${payload.length}B latency=${Date.now() - t0}ms`);
        } catch (err) {
          cacheStats.redisSetFail++;
          console.error(`[Redis SET] ERROR key=${key} latency=${Date.now() - t0}ms err=${err.message}`);
        }
      },
      async delete(key) {
        try {
          await withTimeout(redisClient.del(key), 1500, null);
        } catch (err) {
          console.error('[Redis Store] Error deleting key:', key, err.message);
        }
      }
    };

    return createCache({ stores: [redisStore] });
  }

  console.log('[Cache] Using in-memory cache (no REDIS_URL configured)');
  return createCache({
    ttl: META_TTL,
    max: MEMORY_CACHE_MAX_KEYS
  });
}

const cacheInstance = initiateCache();

// Wrapper toàn cục tự động convert giây -> ms cho cache-manager v7
async function cacheWrapGlobal(key, method, ttl) {
  if (NO_CACHE) {
    if (isVerbose) console.log(`[CacheWrap] SKIP (NO_CACHE) key=${key}`);
    return method();
  }

  if (cacheInstance) {
    const t0 = Date.now();
    try {
      const msTTL = ttl ? ttl * 1000 : undefined;

      // We need to detect cache hit vs miss.
      // Wrap calls the method only on miss, so we track it via a flag.
      let wasMiss = false;
      const wrappedMethod = async () => {
        wasMiss = true;
        return method();
      };

      const result = await cacheInstance.wrap(key, wrappedMethod, msTTL);
      const latency = Date.now() - t0;

      if (wasMiss) {
        cacheStats.wrapMiss++;
        if (isVerbose) console.log(`[CacheWrap] MISS key=${key} latency=${latency}ms (fetched from source)`);
      } else {
        cacheStats.wrapHit++;
        if (isVerbose) console.log(`[CacheWrap] HIT key=${key} latency=${latency}ms`);
      }

      return result;
    } catch (error) {
      cacheStats.wrapError++;
      console.warn(`[CacheWrap] ERROR key=${key} latency=${Date.now() - t0}ms err=${error.message}, falling back to Method`);
    }
  }

  return method();
}

function cacheWrapCatalog(id, method) {
  return cacheWrapGlobal(`${CATALOG_KEY_PREFIX}:v2:${id}`, method, CATALOG_TTL / 1000);
}

function cacheWrapMeta(id, method) {
  return cacheWrapGlobal(`${META_KEY_PREFIX}:${id}`, method, META_TTL / 1000);
}

async function closeConnections() {
  if (redisInstance) {
    try {
      await redisInstance.quit();
      console.log('[Redis] Connection closed gracefully');
    } catch (error) {
      console.error("Error closing Redis connection:", error);
    }
  }
}

process.on('SIGINT', closeConnections);
process.on('SIGTERM', closeConnections);

module.exports = {
  cacheWrapCatalog,
  cacheWrapMeta,
  cacheWrap: cacheWrapGlobal,
  redisInstance: getRedisClient(),
  ramMetaCache,
  ramImdbCache,
  ramAgeRatingCache,
  ramUserCounterCache
};
