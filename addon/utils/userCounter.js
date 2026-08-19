const { redisInstance, ramUserCounterCache } = require('../lib/getCache');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// Helper: Timeout protection for Redis
function withTimeout(promise, ms, fallbackValue) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// Chave base para armazenamento
const USER_COUNT_KEY = 'tmdb-addon:unique-users';
const USER_IPS_KEY = 'tmdb-addon:user-ips';

// URL da instância oficial (pode ser sobrescrita por variável de ambiente)
const OFFICIAL_INSTANCE_URL = process.env.OFFICIAL_INSTANCE_URL || 'https://94c8cb9f702d-tmdb-addon.baby-beamup.club';

// ID único da instância atual (baseado no HOST_NAME ou gerado)
function getInstanceId() {
  const hostName = process.env.HOST_NAME || '';
  if (hostName) {
    try {
      const url = new URL(hostName);
      return url.hostname.replace(/\./g, '-');
    } catch (e) {
      return hostName.replace(/[^a-zA-Z0-9]/g, '-');
    }
  }
  // Gera um ID único baseado no hostname do sistema
  return require('os').hostname().replace(/\./g, '-');
}

const INSTANCE_ID = getInstanceId();

// Verifica se esta é a instância oficial
function isOfficialInstance() {
  const hostName = process.env.HOST_NAME || '';
  if (!hostName) return false;
  
  try {
    const currentUrl = new URL(hostName);
    const officialUrl = new URL(OFFICIAL_INSTANCE_URL);
    return currentUrl.hostname === officialUrl.hostname;
  } catch (e) {
    return hostName.includes('94c8cb9f702d-tmdb-addon.baby-beamup.club');
  }
}

/**
 * Gera um hash do IP para privacidade
 */
function hashIP(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex');
}

/**
 * Obtém o IP real do cliente (considerando proxies)
 */
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const realIP = req.headers['x-real-ip'];
  
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  if (realIP) {
    return realIP;
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

/**
 * Registra um usuário único baseado no IP
 */
async function trackUser(req) {
  const ip = getClientIP(req);
  if (ip === 'unknown') return false;
  
  const ipHash = hashIP(ip);
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const key = `${USER_IPS_KEY}:${today}:${ipHash}`;
  
  try {
    if (redisInstance) {
      const exists = await withTimeout(redisInstance.get(key), 1000, null);
      if (!exists) {
        await withTimeout(redisInstance.set(key, '1', 'EX', 24 * 60 * 60), 1000, null);
        await incrementUserCount();
        return true;
      }
    } else {
      // Fallback para cache em memória local
      const existing = ramUserCounterCache ? await ramUserCounterCache.get(key) : null;
      
      if (!existing) {
        if (ramUserCounterCache) {
          await ramUserCounterCache.set(key, '1', 24 * 60 * 60 * 1000); // 24 horas
        }
        await incrementUserCount();
        return true;
      }
    }
  } catch (error) {
    console.error('Error tracking user:', error);
  }
  
  return false;
}

/**
 * Incrementa o contador total de usuários únicos
 */
async function incrementUserCount() {
  try {
    if (redisInstance) {
      await withTimeout(redisInstance.incr(USER_COUNT_KEY), 1000, null);
    } else if (ramUserCounterCache) {
      const currentRaw = await ramUserCounterCache.get(USER_COUNT_KEY);
      const current = parseInt(currentRaw || '0', 10) || 0;
      await ramUserCounterCache.set(USER_COUNT_KEY, String(current + 1), 365 * 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    console.error('Error incrementing user count:', error);
  }
}

/**
 * Obtém o total de usuários únicos
 */
async function getUserCount() {
  try {
    if (redisInstance) {
      const count = await withTimeout(redisInstance.get(USER_COUNT_KEY), 1000, '0');
      return parseInt(count || '0', 10) || 0;
    } else if (ramUserCounterCache) {
      const count = await ramUserCounterCache.get(USER_COUNT_KEY);
      return parseInt(count || '0', 10) || 0;
    }
    return 0;
  } catch (error) {
    console.error('Error getting user count:', error);
    return 0;
  }
}

/**
 * Registra usuários de outras instâncias (para agregação)
 */
async function trackExternalUsers(count, instanceId) {
  if (!count || count <= 0) return;
  
  try {
    const key = `${USER_COUNT_KEY}:external:${instanceId}`;
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `${key}:${today}`;
    const instanceCountKey = `${USER_COUNT_KEY}:external-count:${instanceId}`;
    const activeInstancesKey = `${USER_COUNT_KEY}:active-instances`;
    
    if (redisInstance) {
      await withTimeout(redisInstance.set(dailyKey, String(count), 'EX', 7 * 24 * 60 * 60), 1000, null);
      await withTimeout(redisInstance.set(instanceCountKey, String(count), 'EX', 2 * 24 * 60 * 60), 1000, null);
      
      try {
        if (typeof redisInstance.sadd === 'function') {
          await withTimeout(redisInstance.sadd(activeInstancesKey, instanceId), 1000, null);
          await withTimeout(redisInstance.expire(activeInstancesKey, 2 * 24 * 60 * 60), 1000, null);
        }
      } catch (e) {
        // Ignore set errors
      }
    } else if (ramUserCounterCache) {
      await ramUserCounterCache.set(dailyKey, String(count), 7 * 24 * 60 * 60 * 1000);
      await ramUserCounterCache.set(instanceCountKey, String(count), 2 * 24 * 60 * 60 * 1000);

      const activeInstances = await ramUserCounterCache.get(activeInstancesKey);
      const instanceList = Array.isArray(activeInstances) ? activeInstances : [];
      if (!instanceList.includes(instanceId)) {
        instanceList.push(instanceId);
      }
      await ramUserCounterCache.set(activeInstancesKey, instanceList, 2 * 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    console.error('Error tracking external users:', error);
  }
}

/**
 * Obtém o total agregado de todas as instâncias
 */
async function getAggregatedUserCount() {
  try {
    const baseCount = await getUserCount();
    
    if (isOfficialInstance()) {
      let aggregatedCount = baseCount;
      
      try {
        if (redisInstance && typeof redisInstance.smembers === 'function') {
          const activeInstancesKey = `${USER_COUNT_KEY}:active-instances`;
          const instanceIds = await withTimeout(redisInstance.smembers(activeInstancesKey), 1000, []);
          
          for (const instanceId of instanceIds) {
            try {
              const instanceCountKey = `${USER_COUNT_KEY}:external-count:${instanceId}`;
              const count = await withTimeout(redisInstance.get(instanceCountKey), 1000, null);
              if (count) {
                aggregatedCount += parseInt(count || '0', 10);
              }
            } catch (e) {
              // Ignore individual errors
            }
          }
        } else if (ramUserCounterCache) {
          const activeInstancesKey = `${USER_COUNT_KEY}:active-instances`;
          const instanceList = await ramUserCounterCache.get(activeInstancesKey);
          
          if (Array.isArray(instanceList)) {
            for (const instanceId of instanceList) {
              try {
                const instanceCountKey = `${USER_COUNT_KEY}:external-count:${instanceId}`;
                const count = await ramUserCounterCache.get(instanceCountKey);
                if (count) {
                  aggregatedCount += parseInt(count || '0', 10);
                }
              } catch (e) {
                // Ignore individual errors
              }
            }
          }
        }
      } catch (error) {
        console.error('Error aggregating external counts:', error);
      }
      
      return aggregatedCount;
    }
    
    return baseCount;
  } catch (error) {
    console.error('Error getting aggregated user count:', error);
    return 0;
  }
}

/**
 * Reseta o contador (útil para testes ou reset diário)
 */
async function resetUserCount() {
  try {
    if (redisInstance) {
      await withTimeout(redisInstance.del(USER_COUNT_KEY), 1000, null);
    } else if (ramUserCounterCache) {
      await ramUserCounterCache.del(USER_COUNT_KEY);
    }
  } catch (error) {
    console.error('Error resetting user count:', error);
  }
}

/**
 * Reporta automaticamente os usuários para a instância oficial
 */
async function reportToOfficialInstance() {
  // Se esta é a instância oficial, não precisa reportar para si mesma
  if (isOfficialInstance()) {
    return;
  }

  try {
    const count = await getUserCount();
    if (count === 0) {
      return; // Não reporta se não há usuários
    }

    const reportUrl = `${OFFICIAL_INSTANCE_URL}/api/stats/report-users`;
    const url = new URL(reportUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const postData = JSON.stringify({
      count: count,
      instanceId: INSTANCE_ID
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'tmdb-addon-user-counter/1.0'
      },
      timeout: 5000 // 5 segundos de timeout
    };

    return new Promise((resolve, reject) => {
      const req = httpModule.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`Successfully reported ${count} users to official instance`);
            resolve(true);
          } else {
            console.warn(`Failed to report users: ${res.statusCode} - ${data}`);
            resolve(false);
          }
        });
      });

      req.on('error', (error) => {
        // Não loga erro para não poluir logs, apenas falha silenciosamente
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.write(postData);
      req.end();
    });
  } catch (error) {
    // Falha silenciosamente para não afetar a aplicação principal
    return false;
  }
}

/**
 * Inicia o reporte automático periódico para a instância oficial
 */
let reportInterval = null;

function startAutoReporting(intervalMinutes = 60) {
  // Se já está rodando, não inicia novamente
  if (reportInterval) {
    return;
  }

  // Se é a instância oficial, não precisa reportar
  if (isOfficialInstance()) {
    return;
  }

  // Reporta imediatamente na primeira vez
  reportToOfficialInstance().catch(() => {});

  // Depois reporta periodicamente
  const intervalMs = intervalMinutes * 60 * 1000;
  reportInterval = setInterval(() => {
    reportToOfficialInstance().catch(() => {});
  }, intervalMs);

  console.log(`Auto-reporting to official instance enabled (every ${intervalMinutes} minutes)`);
}

function stopAutoReporting() {
  if (reportInterval) {
    clearInterval(reportInterval);
    reportInterval = null;
  }
}

module.exports = {
  trackUser,
  getUserCount,
  getAggregatedUserCount,
  trackExternalUsers,
  resetUserCount,
  getClientIP,
  reportToOfficialInstance,
  startAutoReporting,
  stopAutoReporting,
  isOfficialInstance,
  INSTANCE_ID
};
