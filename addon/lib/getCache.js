const cacheManager = require('cache-manager');
const redisStore = require('cache-manager-ioredis');
const Redis = require('ioredis');
const { mongoDbStore } = require('@tirke/node-cache-manager-mongodb');

const GLOBAL_KEY_PREFIX = 'tmdb-addon';
const META_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|meta`;
const CATALOG_KEY_PREFIX = `${GLOBAL_KEY_PREFIX}|catalog`;

function parsePositiveInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const META_TTL = parsePositiveInt(process.env.META_TTL, 7 * 24 * 60 * 60); // 7 day
const CATALOG_TTL = parsePositiveInt(process.env.CATALOG_TTL, 24 * 60 * 60); // 1 day
const MEMORY_CACHE_MAX_KEYS = parsePositiveInt(process.env.MEMORY_CACHE_MAX_KEYS, 5000);

const RAM_META_TTL = parsePositiveInt(process.env.RAM_META_TTL, 3600); // 1 hour
const RAM_META_MAX_KEYS = parsePositiveInt(process.env.RAM_META_MAX_KEYS, 2000);
const RAM_IMDB_TTL = parsePositiveInt(process.env.RAM_IMDB_TTL, 86400); // 24 hours
const RAM_IMDB_MAX_KEYS = parsePositiveInt(process.env.RAM_IMDB_MAX_KEYS, 5000);
const RAM_AGE_RATING_TTL = parsePositiveInt(process.env.RAM_AGE_RATING_TTL, 3600); // 1 hour
const RAM_AGE_RATING_MAX_KEYS = parsePositiveInt(process.env.RAM_AGE_RATING_MAX_KEYS, 5000);
const RAM_USER_COUNTER_TTL = parsePositiveInt(process.env.RAM_USER_COUNTER_TTL, 86400); // 24 hours
const RAM_USER_COUNTER_MAX_KEYS = parsePositiveInt(process.env.RAM_USER_COUNTER_MAX_KEYS, 100000);
// Parse NO_CACHE properly - env vars are strings, so 'false' should be false
const NO_CACHE = process.env.NO_CACHE === 'true' || process.env.NO_CACHE === '1';
const REDIS_URL = process.env.REDIS_URL;
const MONGODB_URI = process.env.MONGODB_URI;

// Redis instance global (se disponível)
let redisInstance = null;

// Log configuration on startup
console.log('[Cache] Configuration:', {
  REDIS_URL: REDIS_URL ? `${REDIS_URL.substring(0, 20)}...` : 'not set',
  MONGODB_URI: MONGODB_URI ? 'configured' : 'not set',
  NO_CACHE: NO_CACHE,
  META_TTL: META_TTL,
  CATALOG_TTL: CATALOG_TTL
});

// Cache principal (Redis ou memória) - usado para dados importantes
const cache = initiateCache();

function createRamCache(ttl, max) {
  return cacheManager.caching({
    store: 'memory',
    ttl,
    max
  });
}

// Dedicated in-process RAM caches (bounded by max keys)
const ramMetaCache = createRamCache(RAM_META_TTL, RAM_META_MAX_KEYS);
const ramImdbCache = createRamCache(RAM_IMDB_TTL, RAM_IMDB_MAX_KEYS);
const ramAgeRatingCache = createRamCache(RAM_AGE_RATING_TTL, RAM_AGE_RATING_MAX_KEYS);
const ramUserCounterCache = createRamCache(RAM_USER_COUNTER_TTL, RAM_USER_COUNTER_MAX_KEYS);

// Cache MongoDB para catalog e meta
let mongoCache = null;

function initiateCache() {
  if (NO_CACHE) {
    console.log('[Cache] NO_CACHE is enabled, caching disabled');
    return null;
  } else if (REDIS_URL) {
    console.log('[Cache] Initializing Redis cache...');

    // Upstash and other cloud Redis providers use TLS (rediss://)
    const isUpstash = REDIS_URL.includes('upstash.io');
    const usesTLS = REDIS_URL.startsWith('rediss://');

    const redisOptions = {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      lazyConnect: false,
      // Enable TLS for Upstash or rediss:// URLs
      tls: (isUpstash || usesTLS) ? { rejectUnauthorized: false } : undefined,
      // Upstash-specific optimizations for serverless
      enableReadyCheck: false,
      connectTimeout: 10000,
    };

    console.log('[Redis] Options:', { isUpstash, usesTLS, tls: !!redisOptions.tls });

    redisInstance = new Redis(REDIS_URL, redisOptions);

    redisInstance.on('connect', () => {
      console.log('[Redis] Connected successfully');
    });

    redisInstance.on('ready', () => {
      console.log('[Redis] Ready to accept commands');
    });

    redisInstance.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    redisInstance.on('close', () => {
      console.log('[Redis] Connection closed');
    });

    redisInstance.on('reconnecting', (delay) => {
      console.log('[Redis] Reconnecting in', delay, 'ms...');
    });

    return cacheManager.caching({
      store: redisStore,
      redisInstance: redisInstance,
      ttl: META_TTL
    });
  } else {
    console.log('[Cache] Using in-memory cache (no REDIS_URL configured)');
    return cacheManager.caching({
      store: 'memory',
      ttl: META_TTL,
      max: MEMORY_CACHE_MAX_KEYS
    });
  }
}

async function initiateMongoCache() {
  if (NO_CACHE || !MONGODB_URI) {
    return null;
  }

  try {
    mongoCache = await cacheManager.caching(mongoDbStore, {
      url: MONGODB_URI,
      ttl: META_TTL
    });
    console.log('MongoDB cache conectado com sucesso');
    return mongoCache;
  } catch (error) {
    console.error('Erro ao conectar MongoDB cache:', error);
    return null;
  }
}

// Inicializa MongoDB cache (lazy initialization)
let mongoInitPromise = null;
async function ensureMongoCache() {
  if (mongoCache) {
    return mongoCache;
  }

  if (!mongoInitPromise) {
    mongoInitPromise = initiateMongoCache();
  }

  return mongoInitPromise;
}

// Helper to use the best available cache
async function cacheWrapGlobal(key, method, ttl) {
  if (NO_CACHE) {
    return method();
  }

  // 1. Try Redis (Fastest)
  if (cache) {
    try {
      return await cache.wrap(key, method, { ttl });
    } catch (error) {
      console.warn(`[Cache] Redis error for ${key}, falling back to MongoDB/Method:`, error.message);
    }
  }

  // 2. Try MongoDB (Durable)
  if (MONGODB_URI) {
    const mongo = await ensureMongoCache();
    if (mongo) {
      try {
        return await mongo.wrap(key, method, { ttl });
      } catch (error) {
        console.warn(`[Cache] MongoDB error for ${key}:`, error.message);
      }
    }
  }

  // 3. Last resort: just the method
  return method();
}

function cacheWrapCatalog(id, method) {
  return cacheWrapGlobal(`${CATALOG_KEY_PREFIX}:v2:${id}`, method, CATALOG_TTL);
}

function cacheWrapMeta(id, method) {
  return cacheWrapGlobal(`${META_KEY_PREFIX}:${id}`, method, META_TTL);
}

// Função para fechar conexões ao encerrar
async function closeConnections() {
  if (redisInstance) {
    try {
      await redisInstance.quit();
    } catch (error) {
      console.error("Error closing Redis connection:", error);
    }
  }
  // O mongoCache gerencia suas próprias conexões através do store
}

// Fecha conexões ao encerrar o processo
process.on('SIGINT', closeConnections);
process.on('SIGTERM', closeConnections);

module.exports = {
  cacheWrapCatalog,
  cacheWrapMeta,
  cacheWrap: cacheWrapGlobal,
  cache,
  redisInstance,
  mongoCache,
  ramMetaCache,
  ramImdbCache,
  ramAgeRatingCache,
  ramUserCounterCache
};
