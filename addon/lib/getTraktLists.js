require('dotenv').config()
const { get } = require('../utils/httpClient')
const { getMeta } = require('./getMeta')
const { parseCatalogItem } = require('../utils/parseProps')

async function getTraktWatchlist(type, language, page, genre, accessToken, config = {}) {
  if (!accessToken) {
    throw new Error('Access token do Trakt não fornecido')
  }

  try {
    const typeParam = type === 'movie' ? 'movies' : 'shows'
    const limit = 20

    const response = await get(`https://api.trakt.tv/sync/watchlist/${typeParam}?limit=${limit}&extended=full`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'trakt-api-version': '2',
        'trakt-api-key': process.env.TRAKT_CLIENT_ID
      }
    })

    const items = response.data || []

    // Process all items in parallel instead of sequential for-loop
    const metas = (await Promise.all(
      items.map(async (item) => {
        try {
          const tmdbId = type === 'movie' ? item.movie?.ids?.tmdb : item.show?.ids?.tmdb
          if (!tmdbId) return null

          const result = await getMeta(type, language, tmdbId, config)
          return result.meta
        } catch (err) {
          console.error(`Erro ao processar item do Trakt:`, err)
          return null
        }
      })
    )).filter(Boolean)

    return { metas }
  } catch (err) {
    console.error('Erro ao buscar watchlist do Trakt:', err)
    throw err
  }
}

async function getTraktRecommendations(type, language, page, genre, accessToken, config = {}) {
  if (!accessToken) {
    throw new Error('Access token do Trakt não fornecido')
  }

  try {
    const typeParam = type === 'movie' ? 'movies' : 'shows'
    const limit = 20

    const response = await get(`https://api.trakt.tv/recommendations/${typeParam}?limit=${limit}&extended=full`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'trakt-api-version': '2',
        'trakt-api-key': process.env.TRAKT_CLIENT_ID
      }
    })

    const items = response.data || []

    // Process all items in parallel instead of sequential for-loop
    const metas = (await Promise.all(
      items.map(async (item) => {
        try {
          const tmdbId = item.ids?.tmdb
          if (!tmdbId) return null

          const result = await getMeta(type, language, tmdbId, config)
          return result.meta
        } catch (err) {
          console.error(`Erro ao processar recomendação do Trakt:`, err)
          return null
        }
      })
    )).filter(Boolean)

    return { metas }
  } catch (err) {
    console.error('Erro ao buscar recomendações do Trakt:', err)
    throw err
  }
}

module.exports = { getTraktWatchlist, getTraktRecommendations }
