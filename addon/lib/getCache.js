const { createCache } = require('cache-manager');
const Redis = require('ioredis');

const GLOBAL_KEY_PREFIX = 'tmdb-addon';
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

  if (REDIS_IS_CLUSTER && REDIS_CLUSTER_NODES.length > 0) {
    console.log('[Cache] Initializing Redis CLUSTER client...');
    redisInstance = new Redis.Cluster(REDIS_CLUSTER_NODES, {
      redisOptions: {
        maxRetriesPerRequest: 3,
        tls: process.env.REDIS_USE_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
      },
      clusterRetryStrategy: (times) => Math.min(times * 100, 2000)
    });
  } else if (REDIS_URL) {
    console.log('[Cache] Initializing Redis Single Node client...');
    const isUpstash = REDIS_URL.includes('upstash.io');
    const usesTLS = REDIS_URL.startsWith('rediss://');

    const redisOptions = {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      lazyConnect: false,
      tls: (isUpstash || usesTLS) ? { rejectUnauthorized: false } : undefined,
      enableReadyCheck: false,
      connectTimeout: 10000,
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

// Khởi tạo cache-manager chính đồng bộ (v7)
function initiateCache() {
  if (NO_CACHE) {
    console.log('[Cache] NO_CACHE is enabled, caching disabled');
    return null;
  }

  const redisClient = getRedisClient();

  if (redisClient) {
    console.log('[Cache] Creating Redis Custom Store for cache-manager v7...');
    const redisStore = {
      async get(key, options) {
        try {
          const val = await redisClient.get(key);
          if (!val) return undefined;

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
          console.error('[Redis Store] Error getting key:', key, err.message);
          return undefined;
        }
      },
      async set(key, value, ttl) {
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

          if (msTTL > 0) {
            await redisClient.set(key, payload, 'PX', msTTL);
          } else {
            await redisClient.set(key, payload);
          }
        } catch (err) {
          console.error('[Redis Store] Error setting key:', key, err.message);
        }
      },
      async delete(key) {
        try {
          await redisClient.del(key);
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
    return method();
  }

  if (cacheInstance) {
    try {
      const msTTL = ttl ? ttl * 1000 : undefined;
      return await cacheInstance.wrap(key, method, msTTL);
    } catch (error) {
      console.warn(`[Cache] Error for ${key}, falling back to Method:`, error.message);
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
