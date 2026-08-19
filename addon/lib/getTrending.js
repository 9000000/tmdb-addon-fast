require("dotenv").config();
const { getTmdbClient } = require("../utils/getTmdbClient");
const { isMovieReleasedInRegion, isMovieReleasedDigitally } = require("./releaseFilter");
const { rateLimitedMapFiltered } = require("../utils/rateLimiter");
const { cacheWrapCatalog } = require("./getCache");
const { parseCatalogItem } = require("../utils/parseProps");

async function getTrending(type, language, page, genre, config = {}) {
  const cacheKey = `trending:${type}:${language}:${page || 1}:${genre || 'day'}:${config.strictRegionFilter || 'false'}:${config.digitalReleaseFilter || 'false'}:${config.rpdbkey || ''}:${config.topposterskey || ''}`;

  return cacheWrapCatalog(cacheKey, async () => {
    const moviedb = getTmdbClient(config);
    const media_type = type === "series" ? "tv" : type;

    const isStrictMode = (config.strictRegionFilter === "true" || config.strictRegionFilter === true);
    const isDigitalFilterMode = (config.digitalReleaseFilter === "true" || config.digitalReleaseFilter === true);
    const region = language && language.split('-')[1] ? language.split('-')[1] : null;
    const needsExtraFetch = type === "movie" && (isStrictMode || isDigitalFilterMode);

    const MIN_RESULTS = 20;
    const PAGES_TO_FETCH = needsExtraFetch ? 3 : 1; // Reduced from 5 to 3 to minimize API calls

    // Helper function to fetch and filter one page
    async function fetchAndFilterPage(pageNum) {
      const parameters = {
        media_type,
        time_window: genre ? genre.toLowerCase() : "day",
        language,
        page: pageNum,
      };

      const res = await moviedb.trending(parameters);

      // Parse all items in parallel — no API calls, just URL generation
      let metas = (await Promise.all(
        res.results.map(async (item) => {
          try {
            return await parseCatalogItem(item, type, language, config);
          } catch (err) {
            console.error(`Error parsing catalog item for ${item.id}:`, err.message);
            return null;
          }
        })
      )).filter(Boolean);

      // Apply strict region filtering for movies
      if (isStrictMode && region && type === "movie") {
        const releaseChecks = await rateLimitedMapFiltered(
          metas,
          async (meta) => {
            const tmdbId = meta.id ? parseInt(meta.id.replace('tmdb:', ''), 10) : null;
            if (!tmdbId) return meta; // Keep if no ID

            const released = await isMovieReleasedInRegion(tmdbId, region, config);
            return released ? meta : null;
          },
          { batchSize: 5, delayMs: 200 }
        );

        metas = releaseChecks;
      }

      // Apply digital release filter for movies (independent from strict mode)
      if (isDigitalFilterMode && !isStrictMode && type === "movie") {
        const digitalChecks = await rateLimitedMapFiltered(
          metas,
          async (meta) => {
            const tmdbId = meta.id ? parseInt(meta.id.replace('tmdb:', ''), 10) : null;
            if (!tmdbId) return meta; // Keep if no ID

            const released = await isMovieReleasedDigitally(tmdbId, config);
            return released ? meta : null;
          },
          { batchSize: 5, delayMs: 200 }
        );

        metas = digitalChecks;
      }

      return metas;
    }

    try {
      const startPage = parseInt(page) || 1;

      // Fetch all pages in parallel for better performance
      const pagePromises = [];
      for (let i = 0; i < PAGES_TO_FETCH; i++) {
        pagePromises.push(fetchAndFilterPage(startPage + i));
      }

      const pageResults = await Promise.all(pagePromises);

      // Combine results, removing duplicates using Set for O(1) lookup
      let metas = [];
      const seenIds = new Set();
      for (const pageMetas of pageResults) {
        for (const meta of pageMetas) {
          if (meta && !seenIds.has(meta.id)) {
            seenIds.add(meta.id);
            metas.push(meta);
          }
        }
        // Stop early if we have enough results
        if (metas.length >= MIN_RESULTS) break;
      }

      // If no results, return a placeholder to prevent iOS from bugging
      if (metas.length === 0) {
        const host = process.env.HOST_NAME ? process.env.HOST_NAME.replace(/\/$/, '') : '';
        const posterUrl = `${host}/no-content.png?v=${Date.now()}`;
        return {
          metas: [{
            id: "tmdb:no-content",
            type: type,
            name: "No Content Available",
            poster: posterUrl,
            background: posterUrl,
            description: "No trending content found. Please try again later.",
            genres: ["No Results"]
          }]
        };
      }

      // Limit to 20 results max
      return { metas: metas.slice(0, 20) };
    } catch (error) {
      console.error(error);
      const host = process.env.HOST_NAME ? process.env.HOST_NAME.replace(/\/$/, '') : '';
      const posterUrl = `${host}/no-content.png?v=${Date.now()}`;
      return {
        metas: [{
          id: "tmdb:no-content",
          type: type,
          name: "Error Loading Content",
          poster: posterUrl,
          background: posterUrl,
          description: "An error occurred while loading content. Please try again.",
          genres: ["Error"]
        }]
      };
    }
  });
}

module.exports = { getTrending };
