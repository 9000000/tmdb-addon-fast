const express = require("express");
const favicon = require('serve-favicon');
const path = require("path")
const addon = express();
const analytics = require('./utils/analytics');
const { getCatalog } = require("./lib/getCatalog");
const { getSearch } = require("./lib/getSearch");
const { getManifest, DEFAULT_LANGUAGE } = require("./lib/getManifest");
const { getMeta } = require("./lib/getMeta");
const { getTmdb } = require("./lib/getTmdb");
const { cacheWrapMeta } = require("./lib/getCache");
const { getTrending } = require("./lib/getTrending");
const { parseConfig, getRpdbPoster, checkIfExists } = require("./utils/parseProps");
const { getRequestToken, getSessionId } = require("./lib/getSession");
const { getFavorites, getWatchList } = require("./lib/getPersonalLists");
const { blurImage } = require('./utils/imageProcessor');
const { toCanonicalType } = require('./utils/typeCanonical');

addon.use(analytics.middleware);
addon.use(favicon(path.join(__dirname, '../public/favicon.png')));
addon.use(express.static(path.join(__dirname, '../public')));
addon.use(express.static(path.join(__dirname, '../dist')));

const getCacheHeaders = function (opts) {
  opts = opts || {};

  if (!Object.keys(opts).length) return false;

  let cacheHeaders = {
    cacheMaxAge: "max-age",
    staleRevalidate: "stale-while-revalidate",
    staleError: "stale-if-error",
  };

  return Object.keys(cacheHeaders)
    .map((prop) => {
      const value = opts[prop];
      if (!value) return false;
      return cacheHeaders[prop] + "=" + value;
    })
    .filter((val) => !!val)
    .join(", ");
};

const respond = function (res, data, opts) {
  const cacheControl = getCacheHeaders(opts);
  if (cacheControl) res.setHeader("Cache-Control", `${cacheControl}, public`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json");
  res.send(data);
};

addon.get("/", function (_, res) {
  res.redirect("/configure");
});

addon.get("/request_token", async function (req, res) {
  const requestToken = await getRequestToken()
  respond(res, requestToken);
});

addon.get("/session_id", async function (req, res) {
  const requestToken = req.query.request_token
  const sessionId = await getSessionId(requestToken)
  respond(res, sessionId);
});

addon.use('/configure', express.static(path.join(__dirname, '../dist')));

addon.use('/configure', (req, res, next) => {
  const config = parseConfig(req.params.catalogChoices) || {};
  next();
});

addon.get('/:catalogChoices?/configure', function (req, res) {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

addon.get("/:catalogChoices?/manifest.json", async function (req, res) {
    const { catalogChoices } = req.params;
    const config = parseConfig(catalogChoices) || {};
    const manifest = await getManifest(config);
    
    const cacheOpts = {
        cacheMaxAge: 12 * 60 * 60,
        staleRevalidate: 14 * 24 * 60 * 60, 
        staleError: 30 * 24 * 60 * 60, 
    };
    respond(res, manifest, cacheOpts);
});

addon.get("/:catalogChoices?/catalog/:type/:id/:extra?.json", async function (req, res) {
  const { catalogChoices, type, id, extra } = req.params;
  
  // Debug logging
  console.log(`[DEBUG] Catalog request - Original type: "${type}", ID: "${id}", Extra: "${extra}"`);
  
  const canonicalType = toCanonicalType(type); // Canonicalize type at entry point
  console.log(`[DEBUG] Canonical type: "${canonicalType}"`);
  
  const config = parseConfig(catalogChoices) || {};
  const language = config.language || DEFAULT_LANGUAGE;
  const rpdbkey = config.rpdbkey
  const sessionId = config.sessionId
  
  const extraParams = extra ? Object.fromEntries(new URLSearchParams(extra).entries()) : {};
  console.log(`[DEBUG] Extra params:`, extraParams);
  
  // Properly decode genre parameter for international characters
  const { skip, search } = extraParams;
  let { genre } = extraParams;
  if (genre) {
    try {
      genre = decodeURIComponent(genre);
      console.log(`[DEBUG] Decoded genre: "${genre}"`);
    } catch (e) {
      console.warn(`[WARNING] Failed to decode genre: "${genre}"`);
    }
  }
  
  const page = Math.ceil(skip ? skip / 100 + 1 : undefined) || 1;
  console.log(`[DEBUG] Page: ${page}, Genre: "${genre}", Skip: ${skip}`);
  
  let metas = [];
  try {
    const args = [canonicalType, language, page]; // Use canonical type

    if (search) {
      console.log(`[DEBUG] Executing search for: "${search}"`);
      metas = await getSearch(id, canonicalType, language, search, config);
    } else {
      switch (id) {
        case "tmdb.trending":
          console.log(`[DEBUG] Executing getTrending with genre: "${genre}"`);
          metas = await getTrending(...args, genre, config);
          break;
        case "tmdb.favorites":
          console.log(`[DEBUG] Executing getFavorites with sessionId: ${sessionId ? 'set' : 'not set'}`);
          metas = await getFavorites(...args, genre, sessionId);
          break;
        case "tmdb.watchlist":
          console.log(`[DEBUG] Executing getWatchList with sessionId: ${sessionId ? 'set' : 'not set'}`);
          metas = await getWatchList(...args, genre, sessionId);
          break;
        default:
          console.log(`[DEBUG] Executing getCatalog with id: "${id}", genre: "${genre}"`);
          metas = await getCatalog(...args, id, genre, config);
          break;
      }
    }
    console.log(`[DEBUG] Retrieved ${metas?.metas?.length || 0} items from ${metas?.constructor?.name || 'unknown source'}`);
    
    // Additional validation
    if (metas?.metas) {
      const sampleItem = metas.metas[0];
      if (sampleItem) {
        console.log(`[DEBUG] Sample item:`, {
          id: sampleItem.id,
          name: sampleItem.name,
          type: sampleItem.type,
          year: sampleItem.year,
          hasGenre: Array.isArray(sampleItem.genre) && sampleItem.genre.length > 0
        });
      }
    }
  } catch (e) {
    console.error(`[ERROR] Catalog request failed:`, e);
    res.status(404).send((e || {}).message || "Not found");
    return;
  }
  const cacheOpts = {
    cacheMaxAge: 1 * 24 * 60 * 60, 
    staleRevalidate: 7 * 24 * 60 * 60,
    staleError: 14 * 24 * 60 * 60,
  };
  if (rpdbkey) {
    try {
      metas = JSON.parse(JSON.stringify(metas));
      metas.metas = await Promise.all(metas.metas.map(async (el) => {
        const rpdbImage = getRpdbPoster(canonicalType, el.id.replace('tmdb:', ''), language, rpdbkey) // Use canonical type 
        el.poster = await checkIfExists(rpdbImage) ? rpdbImage : el.poster;
        return el;
      }))
    } catch (e) { }
  }
  respond(res, metas, cacheOpts);
});

addon.get("/:catalogChoices?/meta/:type/:id.json", async function (req, res) {
  const { catalogChoices, type, id } = req.params;
  const canonicalType = toCanonicalType(type); // Canonicalize type at entry point
  const config = parseConfig(catalogChoices) || {};
  const tmdbId = id.split(":")[1];
  const language = config.language || DEFAULT_LANGUAGE;
  const rpdbkey = config.rpdbkey;
  const imdbId = req.params.id.split(":")[0];

  if (req.params.id.includes("tmdb:")) {
    const resp = await cacheWrapMeta(`${language}:${canonicalType}:${tmdbId}`, async () => {
      return await getMeta(canonicalType, language, tmdbId, rpdbkey, {
        hideEpisodeThumbnails: config.hideEpisodeThumbnails === "true"
      });
    });
    const cacheOpts = {
      staleRevalidate: 20 * 24 * 60 * 60,
      staleError: 30 * 24 * 60 * 60,
    };
    if (canonicalType == "movie") {
      cacheOpts.cacheMaxAge = 14 * 24 * 60 * 60;
    } else if (canonicalType == "series") {
      const hasEnded = !!((resp.releaseInfo || "").length > 5);
      cacheOpts.cacheMaxAge = (hasEnded ? 14 : 1) * 24 * 60 * 60;
    }
    respond(res, resp, cacheOpts);
  }
  if (req.params.id.includes("tt")) {
    const tmdbId = await getTmdb(canonicalType, imdbId);
    if (tmdbId) {
      const resp = await cacheWrapMeta(`${language}:${canonicalType}:${tmdbId}`, async () => {
        return await getMeta(canonicalType, language, tmdbId, rpdbkey, {
          hideEpisodeThumbnails: config.hideEpisodeThumbnails === "true"
        });
      });
      const cacheOpts = {
        staleRevalidate: 20 * 24 * 60 * 60,
        staleError: 30 * 24 * 60 * 60,
      };
      if (canonicalType == "movie") {
        cacheOpts.cacheMaxAge = 14 * 24 * 60 * 60;
      } else if (canonicalType == "series") {
        const hasEnded = !!((resp.releaseInfo || "").length > 5);
        cacheOpts.cacheMaxAge = (hasEnded ? 14 : 1) * 24 * 60 * 60;
      }
      respond(res, resp, cacheOpts);
    } else {
      respond(res, { meta: {} });
    }
  }
});

addon.get("/api/image/blur", async function (req, res) {
  const imageUrl = req.query.url;
  
  if (!imageUrl) {
    return res.status(400).json({ error: 'URL da imagem não fornecida' });
  }

  try {
    const blurredImageBuffer = await blurImage(imageUrl);
    
    if (!blurredImageBuffer) {
      return res.status(500).json({ error: 'Erro ao processar imagem' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    
    res.send(blurredImageBuffer);
  } catch (error) {
    console.error('Erro na rota de blur:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Diagnostic endpoint for testing type canonicalization
addon.get("/debug/test-types", function (req, res) {
  const testCases = [
    'movie',
    'series', 
    'tv',
    'Detaylı Filtre (Film) 🔎',
    'Detaylı Filtre (Dizi) 🔎',
    'unknown'
  ];
  
  const results = testCases.map(type => ({
    input: type,
    canonical: toCanonicalType(type),
    isValid: ['movie', 'series'].includes(toCanonicalType(type))
  }));
  
  res.json({
    typeCanonicalTest: results,
    environment: {
      nodeVersion: process.version,
      hostname: process.env.HOST_NAME,
      defaultLanguage: DEFAULT_LANGUAGE
    },
    timestamp: new Date().toISOString()
  });
});

// Verification endpoint to confirm code version
addon.get("/debug/version", function (req, res) {
  res.json({
    version: "COMPREHENSIVE_DEEP_FIXES_2025_07_13_v3",
    packageVersion: require("../package.json").version,
    hasTypeCanonical: typeof toCanonicalType === 'function',
    codebasePath: __dirname,
    timestamp: new Date().toISOString(),
    fixes: [
      "Type canonicalization at API entry points",
      "Fixed parseMedia function for tv/series",
      "Fixed getMeta IMDB ID extraction", 
      "Fixed all backend functions to use canonical types",
      "Added comprehensive error logging",
      "CRITICAL: Fixed TMDB API type mismatch in getCatalog.js",
      "CRITICAL: Fixed TMDB API type mismatch in getSearch.js", 
      "CRITICAL: Fixed TMDB API type mismatch in getTrending.js",
      "CRITICAL: Fixed TMDB API type mismatch in getPersonalLists.js",
      "Enhanced URL parameter decoding for international characters",
      "Added robust error handling in parseMedia function",
      "Improved genre filtering and validation",
      "Enhanced debug logging throughout catalog pipeline"
    ]
  });
});

// Comprehensive flow test endpoint
addon.get("/debug/test-flow", async function (req, res) {
  const testResults = {
    timestamp: new Date().toISOString(),
    tests: []
  };

  // Test 1: Type canonicalization
  const typeTests = [
    'movie',
    'series', 
    'tv',
    'Detaylı Filtre (Film) 🔎',
    'Detaylı Filtre (Dizi) 🔎'
  ];
  
  testResults.tests.push({
    name: "Type Canonicalization",
    results: typeTests.map(type => ({
      input: type,
      canonical: toCanonicalType(type),
      isValid: ['movie', 'series'].includes(toCanonicalType(type))
    }))
  });

  // Test 2: parseMedia function with TMDB types
  try {
    const testMovie = {
      id: 123,
      title: "Test Movie",
      release_date: "2023-01-01",
      poster_path: "/test.jpg",
      backdrop_path: "/test_backdrop.jpg",
      vote_average: 8.5,
      overview: "Test overview"
    };
    
    const testTv = {
      id: 456,
      name: "Test Series",
      first_air_date: "2023-01-01",
      poster_path: "/test_tv.jpg",
      backdrop_path: "/test_tv_backdrop.jpg",
      vote_average: 9.0,
      overview: "Test TV overview"
    };

    const { parseMedia } = require("./utils/parseProps");
    
    const movieParsed = parseMedia(testMovie, "movie", []);
    const tvParsed = parseMedia(testTv, "tv", []);
    
    testResults.tests.push({
      name: "parseMedia Function",
      results: [
        {
          input: "movie",
          output: movieParsed,
          correctType: movieParsed.type === "movie",
          hasYear: !!movieParsed.year
        },
        {
          input: "tv",
          output: tvParsed,
          correctType: tvParsed.type === "series",
          hasYear: !!tvParsed.year
        }
      ]
    });
  } catch (error) {
    testResults.tests.push({
      name: "parseMedia Function",
      error: error.message
    });
  }

  // Test 3: Config parsing with Turkish types
  try {
    const testConfigs = [
      '{"language":"tr-TR","catalogs":[{"type":"Detaylı Filtre (Film) 🔎","id":"tmdb.top"}]}',
      '{"language":"en-US","catalogs":[{"type":"movie","id":"tmdb.top"}]}'
    ];
    
    const configResults = testConfigs.map(configStr => {
      try {
        const config = JSON.parse(configStr);
        return {
          input: configStr,
          parsed: config,
          hasValidTypes: config.catalogs?.every(cat => 
            ['movie', 'series', 'Detaylı Filtre (Film) 🔎', 'Detaylı Filtre (Dizi) 🔎'].includes(cat.type)
          )
        };
      } catch (e) {
        return { input: configStr, error: e.message };
      }
    });
    
    testResults.tests.push({
      name: "Config Parsing",
      results: configResults
    });
  } catch (error) {
    testResults.tests.push({
      name: "Config Parsing",
      error: error.message
    });
  }

  res.json(testResults);
});

module.exports = addon;
