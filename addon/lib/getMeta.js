require("dotenv").config();
const { TMDBClient } = require("../utils/tmdbClient");
const Utils = require("../utils/parseProps");
const moviedb = new TMDBClient(process.env.TMDB_API);
const { getEpisodes } = require("./getEpisodes");
const { getLogo, getTvLogo } = require("./getLogo");
const { getImdbRating } = require("./getImdbRating");
const { getCachedAgeRating } = require("./getAgeRating");
const { checkSeasonsAndReport } = require("../utils/checkSeasons");
const { toCanonicalType } = require("../utils/typeCanonical");

// Configuration
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const blacklistLogoUrls = ["https://assets.fanart.tv/fanart/tv/0/hdtvlogo/-60a02798b7eea.png"];

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
    console.error(`Error fetching IMDb rating for ${imdbId}:`, err.message);
    return null;
  }
}

// Helper functions
const getCacheKey = (
  type,
  language,
  tmdbId,
  rpdbkey,
  enableAgeRating = false,
  showAgeRatingInGenres = true,
  showAgeRatingWithImdbRating = false
) =>
  `${toCanonicalType(type)}-${language}-${tmdbId}-${rpdbkey}-ageRating:${enableAgeRating}-${showAgeRatingInGenres}-${showAgeRatingWithImdbRating}`;

const processLogo = (logo) => {
  if (!logo || blacklistLogoUrls.includes(logo)) return null;
  return logo.replace("http://", "https://");
};

const buildLinks = (
  imdbRating,
  imdbId,
  title,
  type,
  genres,
  credits,
  language,
  castCount,
  ageRating = null,
  showAgeRatingInGenres = true,
  showAgeRatingWithImdbRating = false
) => [
    Utils.parseImdbLink(imdbRating, imdbId, ageRating, showAgeRatingWithImdbRating),
    Utils.parseShareLink(title, imdbId, type),
    ...Utils.parseGenreLink(genres, type, language, imdbId, ageRating, showAgeRatingInGenres),
    ...Utils.parseCreditsLink(credits, castCount)
  ];

// Helper function to add age rating to genres
const addAgeRatingToGenres = (ageRating, genres, showAgeRatingInGenres = true) => {
  if (!ageRating || !showAgeRatingInGenres) return genres;
  return [ageRating, ...genres];
};

// Movie specific functions
const fetchMovieData = async (tmdbId, language) => {
  return await moviedb.movieInfo({
    id: tmdbId,
    language,
    append_to_response: "videos,credits,external_ids"
  });
};

const buildMovieResponse = async (res, type, language, tmdbId, rpdbkey, config = {}) => {
  const canonicalType = toCanonicalType(type);
  const enableAgeRating = config.enableAgeRating === true || config.enableAgeRating === "true";
  const showAgeRatingInGenres = config.showAgeRatingInGenres !== false && config.showAgeRatingInGenres !== "false";
  const showAgeRatingWithImdbRating = config.showAgeRatingWithImdbRating === true || config.showAgeRatingWithImdbRating === "true";

  const [poster, logo, imdbRatingRaw, ageRating] = await Promise.all([
    Utils.parsePoster(canonicalType, tmdbId, res.poster_path, language, rpdbkey),
    getLogo(tmdbId, language, res.original_language).catch(e => {
      console.warn(`Error fetching logo for movie ${tmdbId}:`, e.message);
      return null;
    }),
    getCachedImdbRating(res.external_ids?.imdb_id, canonicalType),
    enableAgeRating ? getCachedAgeRating(tmdbId, canonicalType, language).catch(e => {
      console.warn(`Error fetching age rating for movie ${tmdbId}:`, e.message);
      return null;
    }) : Promise.resolve(null),
  ]);

  const imdbRating = imdbRatingRaw || res.vote_average?.toFixed(1) || "N/A";
  const castCount = config.castCount
  const returnImdbId = config.returnImdbId === true || config.returnImdbId === "true";
  const hideInCinemaTag = config.hideInCinemaTag === true || config.hideInCinemaTag === "true";

  const parsedGenres = Utils.parseGenres(res.genres);
  const resolvedAgeRating = enableAgeRating ? ageRating : null;

  const response = {
    imdb_id: res.imdb_id,
    country: Utils.parseCoutry(res.production_countries),
    description: res.overview,
    director: Utils.parseDirector(res.credits),
    genre: addAgeRatingToGenres(resolvedAgeRating, parsedGenres, showAgeRatingInGenres),
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
    id: returnImdbId ? res.imdb_id : `tmdb:${tmdbId}`,
    genres: addAgeRatingToGenres(resolvedAgeRating, parsedGenres, showAgeRatingInGenres),
    ageRating: resolvedAgeRating,
    releaseInfo: res.release_date ? res.release_date.substr(0, 4) : "",
    trailerStreams: Utils.parseTrailerStream(res.videos),
    links: buildLinks(
      imdbRating,
      res.imdb_id,
      res.title,
      canonicalType,
      res.genres,
      res.credits,
      language,
      castCount,
      resolvedAgeRating,
      showAgeRatingInGenres,
      showAgeRatingWithImdbRating
    ),
    behaviorHints: {
      defaultVideoId: res.imdb_id ? res.imdb_id : `tmdb:${res.id}`,
      hasScheduledVideos: false
    },
    logo: processLogo(logo),
    app_extras: {
      cast: Utils.parseCast(res.credits, castCount)
    }
  };
  if (hideInCinemaTag) delete response.imdb_id;
  return response;
};

// TV show specific functions
const fetchTvData = async (tmdbId, language) => {
  return await moviedb.tvInfo({
    id: tmdbId,
    language,
    append_to_response: "videos,credits,external_ids"
  });
};

const buildTvResponse = async (res, type, language, tmdbId, rpdbkey, config = {}) => {
  const canonicalType = toCanonicalType(type);
  const runtime = res.episode_run_time?.[0] ?? res.last_episode_to_air?.runtime ?? res.next_episode_to_air?.runtime ?? null;
  const enableAgeRating = config.enableAgeRating === true || config.enableAgeRating === "true";
  const showAgeRatingInGenres = config.showAgeRatingInGenres !== false && config.showAgeRatingInGenres !== "false";
  const showAgeRatingWithImdbRating = config.showAgeRatingWithImdbRating === true || config.showAgeRatingWithImdbRating === "true";

  const [poster, logo, imdbRatingRaw, episodes, ageRating] = await Promise.all([
    Utils.parsePoster(canonicalType, tmdbId, res.poster_path, language, rpdbkey),
    getTvLogo(res.external_ids?.tvdb_id, res.id, language, res.original_language).catch(e => {
      console.warn(`Error fetching logo for series ${tmdbId}:`, e.message);
      return null;
    }),
    getCachedImdbRating(res.external_ids?.imdb_id, canonicalType),
    getEpisodes(language, tmdbId, res.external_ids?.imdb_id, res.seasons, {
      hideEpisodeThumbnails: config.hideEpisodeThumbnails
    }).catch(e => {
      console.warn(`Error fetching episodes for series ${tmdbId}:`, e.message);
      return [];
    }),
    enableAgeRating ? getCachedAgeRating(tmdbId, canonicalType, language).catch(e => {
      console.warn(`Error fetching age rating for series ${tmdbId}:`, e.message);
      return null;
    }) : Promise.resolve(null)
  ]);

  const imdbRating = imdbRatingRaw || res.vote_average?.toFixed(1) || "N/A";
  const castCount = config.castCount
  const returnImdbId = config.returnImdbId === true || config.returnImdbId === "true";
  const hideInCinemaTag = config.hideInCinemaTag === true || config.hideInCinemaTag === "true";
  const parsedGenres = Utils.parseGenres(res.genres);
  const resolvedAgeRating = enableAgeRating ? ageRating : null;

  const response = {
    country: Utils.parseCoutry(res.production_countries),
    description: res.overview,
    genre: addAgeRatingToGenres(resolvedAgeRating, parsedGenres, showAgeRatingInGenres),
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
    id: returnImdbId ? res.imdb_id : `tmdb:${tmdbId}`,
    genres: addAgeRatingToGenres(resolvedAgeRating, parsedGenres, showAgeRatingInGenres),
    ageRating: resolvedAgeRating,
    releaseInfo: Utils.parseYear(res.status, res.first_air_date, res.last_air_date),
    videos: episodes || [],
    links: buildLinks(
      imdbRating,
      res.external_ids.imdb_id,
      res.name,
      canonicalType,
      res.genres,
      res.credits,
      language,
      castCount,
      resolvedAgeRating,
      showAgeRatingInGenres,
      showAgeRatingWithImdbRating
    ),
    trailers: Utils.parseTrailers(res.videos),
    trailerStreams: Utils.parseTrailerStream(res.videos),
    behaviorHints: {
      defaultVideoId: null,
      hasScheduledVideos: true
    },
    logo: processLogo(logo),
    app_extras: {
      cast: Utils.parseCast(res.credits, castCount)
    }
  };
  if (hideInCinemaTag) delete response.imdb_id;

  // Season check (without opening issue)
  if (response.imdb_id && response.videos && response.name) {
    // Call the check, but comment out the Issue part inside the function
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
  const enableAgeRating = config.enableAgeRating === true || config.enableAgeRating === "true";
  const showAgeRatingInGenres = config.showAgeRatingInGenres !== false && config.showAgeRatingInGenres !== "false";
  const showAgeRatingWithImdbRating = config.showAgeRatingWithImdbRating === true || config.showAgeRatingWithImdbRating === "true";

  const cacheKey = getCacheKey(
    canonicalType,
    language,
    tmdbId,
    rpdbkey,
    enableAgeRating,
    showAgeRatingInGenres,
    showAgeRatingWithImdbRating
  );
  const cachedData = cache.get(cacheKey);

  if (cachedData && (Date.now() - cachedData.timestamp) < CACHE_TTL) {
    return Promise.resolve({ meta: cachedData.data });
  }

  try {
    const meta = await (canonicalType === "movie" ?
      fetchMovieData(tmdbId, language).then(res => buildMovieResponse(res, canonicalType, language, tmdbId, rpdbkey, {
        ...config,
        enableAgeRating,
        showAgeRatingInGenres,
        showAgeRatingWithImdbRating
      })) :
      fetchTvData(tmdbId, language).then(res => buildTvResponse(res, canonicalType, language, tmdbId, rpdbkey, {
        ...config,
        enableAgeRating,
        showAgeRatingInGenres,
        showAgeRatingWithImdbRating
      }))
    );

    cache.set(cacheKey, { data: meta, timestamp: Date.now() });
    return Promise.resolve({ meta });
  } catch (error) {
    console.error(`Error in getMeta: ${error.message}`);
    throw error;
  }
}

module.exports = { getMeta };