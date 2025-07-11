// addon/lib/getTmdb.js

require('dotenv').config()
const { MovieDb } = require('moviedb-promise')
const moviedb = new MovieDb(process.env.TMDB_API)

async function getTmdb(type, imdbId) {
  try {
    const res = await moviedb.find({ id: imdbId, external_source: 'imdb_id' });

    if (type === "movie") {
      const tmdbId = res.movie_results && res.movie_results.length > 0 ? res.movie_results[0].id : null;
      if (!tmdbId) {
        console.warn(`[WARNING] IMDb Movie ID ${imdbId} not found on TMDB. Returning null.`);
      }
      return tmdbId;
    } else { // type === "series"
      const tmdbId = res.tv_results && res.tv_results.length > 0 ? res.tv_results[0].id : null;
      if (!tmdbId) {
        console.warn(`[WARNING] IMDb TV ID ${imdbId} not found on TMDB. Returning null.`);
      }
      return tmdbId;
    }
  } catch (err) {
    console.error(`[ERROR] Error converting IMDb ID ${imdbId} to TMDB ID:`, err.message);
    return null; // Explicitly return null on error
  }
}

module.exports = { getTmdb };
