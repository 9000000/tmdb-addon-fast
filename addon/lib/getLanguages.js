require("dotenv").config();
const { getTmdbClient } = require("../utils/getTmdbClient");

const { cacheWrap } = require("./getCache");

// Fallback languages when TMDB API key is not available
const FALLBACK_LANGUAGES = require("../static/fallback-languages.json");

const LANGUAGES_TTL = 24 * 60 * 60; // 24 hours in seconds

async function getLanguages(config = {}) {
  const cacheKey = `static:languages`;

  return await cacheWrap(cacheKey, async () => {
    try {
      const moviedb = getTmdbClient(config);
      const [primaryTranslations, languages] = await Promise.all([
        moviedb.primaryTranslations(),
        moviedb.languages(),
      ]);
      return primaryTranslations.map((element) => {
        const [language, country] = element.split("-");
        const findLanguage = languages.find((obj) => obj.iso_639_1 === language);
        return { iso_639_1: element, name: findLanguage?.english_name || element };
      });
    } catch (error) {
      // If TMDB API key is missing or invalid, return fallback languages
      if (error.message === "TMDB_API_KEY_MISSING" || error.message === "TMDB_API_KEY_INVALID") {
        console.warn("TMDB API key not available or invalid, using fallback languages");
        return FALLBACK_LANGUAGES;
      }
      
      // Trata outros erros de API (timeout, network, etc.) com fallback
      console.warn("Error fetching languages from TMDB, using fallback:", error.message);
      return FALLBACK_LANGUAGES;
    }
  }, LANGUAGES_TTL);
}

module.exports = { getLanguages };
