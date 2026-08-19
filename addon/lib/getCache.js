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

const META_TTL = process.env.META_TTL || 7 * 24 * 60 * 60; // 7 days
const CATALOG_TTL = process.env.CATALOG_TTL || 1 * 24 * 60 * 60; // 1 day
const MEMORY_CACHE_MAX_KEYS = parsePositiveInt(process.env.MEMORY_CACHE_MAX_KEYS, 5000);

const RAM_META_TTL = parsePositiveInt(process.env.RAM_META_TTL, 3600); // 1 hour
const RAM_META_MAX_KEYS = parsePositiveInt(process.env.RAM_META_MAX_KEYS, 2000);
const RAM_IMDB_TTL = parsePositiveInt(process.env.RAM_IMDB_TTL, 86400); // 24 hours
const RAM_IMDB_MAX_KEYS = parsePositiveInt(process.env.RAM_IMDB_MAX_KEYS, 5000);
const RAM_AGE_RATING_TTL = parsePositiveInt(process.env.RAM_AGE_RATING_TTL, 3600); // 1 hour
const RAM_AGE_RATING_MAX_KEYS = parsePositiveInt(process.env.RAM_AGE_RATING_MAX_KEYS, 5000);
const RAM_USER_COUNTER_TTL = parsePositiveInt(process.env.RAM_USER_COUNTER_TTL, 86400); // 24 hours
const RAM_USER_COUNTER_MAX_KEYS = parsePositiveInt(process.env.RAM_USER_COUNTER_MAX_KEYS, 100000);

const NO_CACHE = process.env.NO_CACHE === 'true' || process.env.NO_CACHE === true;
const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || process.env.KV_URL;
const MONGODB_URI = process.env.MONGODB_URI;

// Hỗ trợ Redis Cluster
const REDIS_IS_CLUSTER = process.env.REDIS_IS_CLUSTER === 'true';
const REDIS_CLUSTER_NODES = process.env.REDIS_CLUSTER_NODES
  ? process.env.REDIS_CLUSTER_NODES.split(',').map(node => {
      const [host, port] = node.trim().split(':');
      return { host, port: parseInt(port, 10) || 6379 };
    })
  : [];

// Redis instance global (se disponível)
let redisInstance = null;

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
    return null;
  }

  if (REDIS_IS_CLUSTER && REDIS_CLUSTER_NODES.length > 0) {
    try {
      console.log('[Cache] Initializing Redis CLUSTER client...');
      redisInstance = new Redis.Cluster(REDIS_CLUSTER_NODES, {
        redisOptions: {
          maxRetriesPerRequest: 3,
          tls: process.env.REDIS_USE_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
        },
        clusterRetryStrategy: (times) => Math.min(times * 100, 2000)
      });

      redisInstance.on('connect', () => console.log('[Redis Cluster] Connected successfully'));
      redisInstance.on('ready', () => console.log('[Redis Cluster] Ready to accept commands'));
      redisInstance.on('error', (err) => console.error('[Redis Cluster] Error:', err.message));

      return cacheManager.caching({
        store: redisStore,
        redisInstance: redisInstance,
        ttl: META_TTL
      });
    } catch (err) {
      console.error('[Cache] Failed to initialize Redis Cluster, falling back to memory:', err.message);
    }
  } else if (REDIS_URL) {
    try {
      console.log('[Cache] Initializing Redis client with URL configured...');
      const isUpstash = REDIS_URL.includes('upstash.io');
      const usesTLS = REDIS_URL.startsWith('rediss://') || process.env.REDIS_USE_TLS === 'true';

      const redisOptions = {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        connectTimeout: 10000,
        enableReadyCheck: false,
        lazyConnect: false,
        tls: (isUpstash || usesTLS) ? { rejectUnauthorized: false } : undefined,
        retryStrategy(times) {
          if (times > 3) return null; // Prevent hanging retries on serverless cold starts
          return Math.min(times * 100, 1000);
        }
      };

      redisInstance = new Redis(REDIS_URL, redisOptions);

      redisInstance.on('connect', () => {
        console.log('[Redis] Connected successfully');
      });

      redisInstance.on('ready', () => {
        console.log('[Redis] Ready to accept commands');
      });

      redisInstance.on('error', (error) => {
        console.error('[Redis] Connection error:', error.message);
      });

      return cacheManager.caching({
        store: redisStore,
        redisInstance: redisInstance,
        ttl: META_TTL
      });
    } catch (err) {
      console.error('[Cache] Failed to initialize Redis store, falling back to memory:', err.message);
      return cacheManager.caching({
        store: 'memory',
        ttl: META_TTL,
        max: MEMORY_CACHE_MAX_KEYS
      });
    }
  }

  return cacheManager.caching({
    store: 'memory',
    ttl: META_TTL,
    max: MEMORY_CACHE_MAX_KEYS
  });
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

async function cacheWrap(key, method, options) {
  if (NO_CACHE || !cache) {
    return method();
  }
  try {
    return await cache.wrap(key, method, options);
  } catch (error) {
    console.error(`[Cache] Error for key ${key}:`, error.message || error);
    return method();
  }
}

async function cacheWrapMongo(key, method, ttl) {
  if (NO_CACHE || !MONGODB_URI) {
    return method();
  }

  // Garante que MongoDB cache está inicializado
  const mongo = await ensureMongoCache();
  
  if (!mongo) {
    return method();
  }

  try {
    return await mongo.wrap(key, method, { ttl });
  } catch (error) {
    console.error(`Erro no cache MongoDB para chave ${key}:`, error);
    // Em caso de erro, executa o método sem cache
    return method();
  }
}

function cacheWrapCatalog(id, method) {
  if (MONGODB_URI) {
    return cacheWrapMongo(`${CATALOG_KEY_PREFIX}:${id}`, method, CATALOG_TTL);
  }
  return cacheWrap(`${CATALOG_KEY_PREFIX}:${id}`, method, { ttl: CATALOG_TTL });
}

function cacheWrapMeta(id, method) {
  if (MONGODB_URI) {
    return cacheWrapMongo(`${META_KEY_PREFIX}:${id}`, method, META_TTL);
  }
  return cacheWrap(`${META_KEY_PREFIX}:${id}`, method, { ttl: META_TTL });
}

async function getCacheStatus() {
  const status = {
    noCache: !!NO_CACHE,
    hasRedisUrl: !!REDIS_URL,
    hasMongoUri: !!MONGODB_URI,
    cacheType: NO_CACHE ? 'disabled' : (REDIS_URL ? 'redis' : (MONGODB_URI ? 'mongodb' : 'memory')),
    redisConnected: false,
    pingTimeMs: null,
    error: null
  };

  if (redisInstance) {
    try {
      const start = Date.now();
      const pong = await redisInstance.ping();
      status.redisConnected = pong === 'PONG';
      status.pingTimeMs = Date.now() - start;
    } catch (err) {
      status.error = err.message;
    }
  }

  return status;
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
  cacheWrap,
  cache,
  redisInstance,
  mongoCache,
  ramMetaCache,
  ramImdbCache,
  ramAgeRatingCache,
  ramUserCounterCache,
  getCacheStatus
};
