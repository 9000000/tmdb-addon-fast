require('dotenv').config()
const { TMDBClient } = require('../utils/tmdbClient')
const moviedb = new TMDBClient(process.env.TMDB_API)
const { toCanonicalType } = require('../utils/typeCanonical')

async function getTmdb(type, imdbId) {
  const canonicalType = toCanonicalType(type)
  if (canonicalType === "movie") {
    const tmdbId = await moviedb
    .find({id: imdbId, external_source: 'imdb_id'})
    .then((res) => {
      return res.movie_results[0] ? res.movie_results[0].id : null;
    })
    .catch(err => {
      return null
    });
return tmdbId;
  } else {
    const tmdbId = await moviedb
    .find({id: imdbId, external_source: 'imdb_id'})
    .then((res) => {
      return res.tv_results[0] ? res.tv_results[0].id : null;
    })
    .catch(err => {
      return null
    });
return tmdbId;
  }
}

module.exports = { getTmdb };