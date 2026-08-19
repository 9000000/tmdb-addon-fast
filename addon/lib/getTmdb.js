require('dotenv').config()
const { getTmdbClient } = require('../utils/getTmdbClient')

const { ramImdbCache } = require('./getCache');

async function getTmdb(type, imdbId, config = {}) {
  if (!imdbId) return null;
  const cacheKey = `imdb:${type}:${imdbId}`;
  
  if (ramImdbCache) {
    const cached = await ramImdbCache.get(cacheKey);
    if (cached) {
      console.log(`[getTmdb] RAM HIT: ${imdbId} -> tmdbId=${cached}`);
      return cached;
    }
  }

  try {
    const t0 = Date.now();
    const moviedb = getTmdbClient(config);
    let tmdbId = null;
    if (type === "movie") {
      const res = await moviedb.find({ id: imdbId, external_source: 'imdb_id' });
      tmdbId = res.movie_results[0] ? res.movie_results[0].id : null;
    } else {
      const res = await moviedb.find({ id: imdbId, external_source: 'imdb_id' });
      tmdbId = res.tv_results[0] ? res.tv_results[0].id : null;
    }

    console.log(`[getTmdb] API LOOKUP: ${imdbId} -> tmdbId=${tmdbId} (${Date.now() - t0}ms)`);

    if (tmdbId && ramImdbCache) {
      await ramImdbCache.set(cacheKey, tmdbId);
    }
    return tmdbId;
  } catch (err) {
    if (err.message !== "TMDB_API_KEY_MISSING" && err.message !== "TMDB_API_KEY_INVALID") {
      console.error(`[getTmdb] ERROR: ${imdbId} err=${err.message}`);
    }
    return null;
  }
}

module.exports = { getTmdb };
