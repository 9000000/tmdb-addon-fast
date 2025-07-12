// addon/lib/getMeta.js

require("dotenv").config();
const { MovieDb } = require("moviedb-promise");
const Utils = require("../utils/parseProps");
const { toCanonicalType } = require("../utils/typeCanonical");
const moviedb = new MovieDb(process.env.TMDB_API);
const { getEpisodes } = require("./getEpisodes");
const { getLogo, getTvLogo } = require("./getLogo");
const { getImdbRating } = require("./getImdbRating");
const { checkSeasonsAndReport } = require("../utils/checkSeasons");

// Configuration
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const blacklistLogoUrls = [ "https://assets.fanart.tv/fanart/tv/0/hdtvlogo/-60a02798b7eea.png" ];

// Cache
const cache = new Map();
const imdbCache = new Map();
async function getCachedImdbRating(imdbId, type) {
  if (!imdbId) return null;
  if (imdbCache.has(imdbId)) return imdbCache.get(imdbId);
  try {
    const rating = await getImdbRating(imdbId, type);
    imdbCache.set(imdbId, rating);
    return rating;
  } catch (err) {
    console.error(`Erro ao buscar IMDb rating para ${imdbId}:`, err.message);
    return null;
  }
}

// Helper functions
const getCacheKey = (type, language, tmdbId, rpdbkey) =>
  `${toCanonicalType(type)}-${language}-${tmdbId}-${rpdbkey}`;

const processLogo = (logo) => {
  if (!logo || blacklistLogoUrls.includes(logo)) return null;
  return logo.replace("http://", "https://");
};

const buildLinks = (imdbRating, imdbId, title, type, genres, credits, language) => {
  const canonicalType = toCanonicalType(type);
  return [
    Utils.parseImdbLink(imdbRating, imdbId),
    Utils.parseShareLink(title, imdbId, canonicalType),
    ...Utils.parseGenreLink(genres, canonicalType, language),
    ...Utils.parseCreditsLink(credits)
  ];
};

// Movie specific functions
const fetchMovieData = async (tmdbId, language) => {
  try {
    console.log(`[DEBUG] Fetching movie data for TMDB ID: ${tmdbId}, Language: ${language}`); // Existing debug log
    const res = await moviedb.movieInfo({
      id: tmdbId,
      language,
      append_to_response: "videos,credits,external_ids"
    });
    return res;
  } catch (error) {
    // Check for 404 or other errors related to resource not found
    if (error.response && error.response.status === 404) {
      console.warn(`[WARNING] TMDB Movie ID ${tmdbId} not found (404). Returning null.`);
      return null; // Return null if movie not found
    }
    console.error(`[ERROR] Error fetching movie data for TMDB ID ${tmdbId}:`, error.message);
    throw error; // Re-throw other unexpected errors
  }
};

const buildMovieResponse = async (res, type, language, tmdbId, rpdbkey, config = {}) => {
  const canonicalType = toCanonicalType(type);
  if (canonicalType !== "movie" && canonicalType !== "series") {
    console.error(`[ERROR] Unexpected canonical type in buildMovieResponse: ${canonicalType}`);
  }
  const [poster, logo, imdbRatingRaw] = await Promise.all([
    Utils.parsePoster(canonicalType, tmdbId, res.poster_path, language, rpdbkey),
    getLogo(tmdbId, language, res.original_language).catch(e => {
      console.warn(`Erro ao buscar logo para filme ${tmdbId}:`, e.message);
      return null;
    }),
    getCachedImdbRating(res.external_ids?.imdb_id, canonicalType),
  ]);

  const imdbRating = imdbRatingRaw || res.vote_average?.toFixed(1) || "N/A";
  const castCount = 10; // This value comes from config, consider using config.castCount directly
  const hideInCinemaTag = config.hideInCinemaTag === true || config.hideInCinemaTag === "true";

  const response = {
    imdb_id: res.imdb_id,
    country: Utils.parseCoutry(res.production_countries),
    description: res.overview,
    director: Utils.parseDirector(res.credits),
    genre: Utils.parseGenres(res.genres),
    imdbRating,
    name: res.title,
    released: new Date(res.release_date),
    slug: Utils.parseSlug(canonicalType, res.title, res.imdb_id),
    type: canonicalType,
    writer: Utils.parseWriter(res.credits),
    year: res.release_date ? res.release_date.substr(0, 4) : "",
    trailers: Utils.parseTrailers(res.videos),
    background: `https://image.tmdb.org/t/p/original${res.backdrop_path}`,
    poster,
    runtime: Utils.parseRunTime(res.runtime),
    id: `tmdb:${tmdbId}`,
    genres: Utils.parseGenres(res.genres),
    releaseInfo: res.release_date ? res.release_date.substr(0, 4) : "",
    trailerStreams: Utils.parseTrailerStream(res.videos),
    links: buildLinks(imdbRating, res.imdb_id, res.title, canonicalType, res.genres, res.credits, language),
    behaviorHints: {
      defaultVideoId: res.imdb_id ? res.imdb_id : `tmdb:${res.id}`,
      hasScheduledVideos: false
    },
    logo: processLogo(logo),
    app_extras: {
      cast: Utils.parseCast(res.credits, config.castCount !== undefined ? config.castCount : castCount) // Use config.castCount
    }
  };
  if (hideInCinemaTag) delete response.imdb_id;
  return response;
};

// TV show specific functions
const fetchTvData = async (tmdbId, language) => {
  try {
    console.log(`[DEBUG] Fetching TV data for TMDB ID: ${tmdbId}, Language: ${language}`); // Existing debug log
    const res = await moviedb.tvInfo({
      id: tmdbId,
      language,
      append_to_response: "videos,credits,external_ids"
    });
    return res;
  } catch (error) {
    // Check for 404 or other errors related to resource not found
    if (error.response && error.response.status === 404) {
      console.warn(`[WARNING] TMDB TV ID ${tmdbId} not found (404). Returning null.`);
      return null; // Return null if TV show not found
    }
    console.error(`[ERROR] Error fetching TV data for TMDB ID ${tmdbId}:`, error.message);
    throw error; // Re-throw other unexpected errors
  }
};

const buildTvResponse = async (res, type, language, tmdbId, rpdbkey, config = {}) => {
  const canonicalType = toCanonicalType(type);
  if (canonicalType !== "movie" && canonicalType !== "series") {
    console.error(`[ERROR] Unexpected canonical type in buildTvResponse: ${canonicalType}`);
  }
  const runtime = res.episode_run_time?.[0] ?? res.last_episode_to_air?.runtime ?? res.next_episode_to_air?.runtime ?? null;

  const [poster, logo, imdbRatingRaw, episodes] = await Promise.all([
    Utils.parsePoster(canonicalType, tmdbId, res.poster_path, language, rpdbkey),
    getTvLogo(res.external_ids?.tvdb_id, res.id, language, res.original_language).catch(e => {
      console.warn(`Erro ao buscar logo para série ${tmdbId}:`, e.message);
      return null;
    }),
    getCachedImdbRating(res.external_ids?.imdb_id, canonicalType),
    getEpisodes(language, tmdbId, res.external_ids?.imdb_id, res.seasons, {
      hideEpisodeThumbnails: config.hideEpisodeThumbnails
    }).catch(e => {
      console.warn(`Erro ao buscar episódios da série ${tmdbId}:`, e.message);
      return [];
    })
  ]);

  const imdbRating = imdbRatingRaw || res.vote_average?.toFixed(1) || "N/A";
  const castCount = 10; // This value comes from config, consider using config.castCount directly
  const hideInCinemaTag = config.hideInCinemaTag === true || config.hideInCinemaTag === "true";

  const response = {
    country: Utils.parseCoutry(res.production_countries),
    description: res.overview,
    genre: Utils.parseGenres(res.genres),
    imdbRating,
    imdb_id: res.external_ids.imdb_id,
    name: res.name,
    poster,
    released: new Date(res.first_air_date),
    runtime: Utils.parseRunTime(runtime),
    status: res.status,
    type: canonicalType,
    writer: Utils.parseCreatedBy(res.created_by),
    year: Utils.parseYear(res.status, res.first_air_date, res.last_air_date),
    background: `https://image.tmdb.org/t/p/original${res.backdrop_path}`,
    slug: Utils.parseSlug(canonicalType, res.name, res.external_ids.imdb_id),
    id: `tmdb:${tmdbId}`,
    genres: Utils.parseGenres(res.genres),
    releaseInfo: Utils.parseYear(res.status, res.first_air_date, res.last_air_date),
    videos: episodes || [],
    links: buildLinks(imdbRating, res.external_ids.imdb_id, res.name, canonicalType, res.genres, res.credits, language),
    trailers: Utils.parseTrailers(res.videos),
    trailerStreams: Utils.parseTrailerStream(res.videos),
    behaviorHints: {
      defaultVideoId: null,
      hasScheduledVideos: true
    },
    logo: processLogo(logo),
    app_extras: {
      cast: Utils.parseCast(res.credits, config.castCount !== undefined ? config.castCount : castCount) // Use config.castCount
    }
  };
  if (hideInCinemaTag) delete response.imdb_id;

  // Checagem de seasons (sem abrir issue)
  if (response.imdb_id && response.videos && response.name) {
    // Chama a checagem, mas comenta a parte do Issue dentro da função
    checkSeasonsAndReport(
      tmdbId,
      response.imdb_id,
      { meta: response },
      response.name
    );
  }

  return response;
};

// Main function
async function getMeta(type, language, tmdbId, rpdbkey, config = {}) {
  const canonicalType = toCanonicalType(type);
  if (canonicalType !== "movie" && canonicalType !== "series") {
    console.error(`[ERROR] Unexpected canonical type in getMeta: ${canonicalType}`);
  }
  const cacheKey = getCacheKey(canonicalType, language, tmdbId, rpdbkey);
  const cachedData = cache.get(cacheKey);

  if (cachedData && (Date.now() - cachedData.timestamp) < CACHE_TTL) {
    return Promise.resolve({ meta: cachedData.data });
  }

  try {
    const res = await (canonicalType === "movie" ?
      fetchMovieData(tmdbId, language) :
      fetchTvData(tmdbId, language)
    );

    // If fetchMovieData or fetchTvData returned null (e.g., due to 404)
    if (res === null) {
      return { meta: null }; // Return null meta to indicate not found
    }

    const meta = await (canonicalType === "movie" ?
      buildMovieResponse(res, canonicalType, language, tmdbId, rpdbkey, config) :
      buildTvResponse(res, canonicalType, language, tmdbId, rpdbkey, config)
    );

    cache.set(cacheKey, { data: meta, timestamp: Date.now() });
    return Promise.resolve({ meta });
  } catch (error) {
    console.error(`Error in getMeta for TMDB ID ${tmdbId}: ${error.message}`);
    // Do not re-throw here, let the calling function handle the null meta
    return { meta: null };
  }
}

module.exports = { getMeta };
