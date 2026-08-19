require('dotenv').config()
const { get } = require('../utils/httpClient')

async function getRequestToken(apiKey) {
  const key = apiKey || process.env.TMDB_API;
  if (!key) {
    return { 
      success: false, 
      status_message: 'TMDB API key is missing. Please enter your TMDB API Key in the configuration or set TMDB_API in server environment.' 
    };
  }
  return get(`https://api.themoviedb.org/3/authentication/token/new?api_key=${key}`)
    .then((res) => {
      return res.data
    })
    .catch(err => {
      const message = err.response?.data?.status_message || err.message;
      return { success: false, status_message: message }
    })
}

async function getSessionId(requestToken, apiKey) {
  const key = apiKey || process.env.TMDB_API;
  if (!key) {
    return { 
      success: false, 
      status_message: 'TMDB API key is missing. Please enter your TMDB API Key in the configuration or set TMDB_API in server environment.' 
    };
  }
  return get(`https://api.themoviedb.org/3/authentication/session/new?api_key=${key}&request_token=${requestToken}`)
    .then((res) => {
      return res.data
    })
    .catch(err => {
      const message = err.response?.data?.status_message || err.message;
      return { success: false, status_message: message }
    })
}

module.exports = { getRequestToken, getSessionId };