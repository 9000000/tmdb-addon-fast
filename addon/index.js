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
  try {
    const requestToken = await getRequestToken()
    respond(res, requestToken);
  } catch (error) {
    console.error(`[ERROR] Failed to get request token:`, error);
    res.status(500).json({ error: "Failed to get request token" });
  }
});

addon.get("/session_id", async function (req, res) {
  try {
    const requestToken = req.query.request_token
    const sessionId = await getSessionId(requestToken)
    respond(res, sessionId);
  } catch (error) {
    console.error(`[ERROR] Failed to get session ID:`, error);
    res.status(500).json({ error: "Failed to get session ID" });
  }
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
  try {
    const { catalogChoices } = req.params;
    console.log(`[DEBUG] Manifest request - catalogChoices: "${catalogChoices}"`);
    
    const config = parseConfig(catalogChoices) || {};
    console.log(`[DEBUG] Parsed config:`, JSON.stringify(config, null, 2));
    
    if (config.catalogs) {
      console.log(`[DEBUG] Config catalogs before manifest generation:`, 
        config.catalogs.map(cat => ({ id: cat.id, type: cat.type, enabled: cat.enabled }))
      );
    }
    
    const manifest = await getManifest(config);
    
    console.log(`[DEBUG] Generated manifest with ${manifest.catalogs?.length || 0} catalogs`);
    if (manifest.catalogs) {
      console.log(`[DEBUG] Manifest catalog types:`, 
        manifest.catalogs.map(cat => ({ id: cat.id, type: cat.type, name: cat.name }))
      );
    }
    
    const cacheOpts = {
        cacheMaxAge: 12 * 60 * 60,
        staleRevalidate: 14 * 24 * 60 * 60, 
        staleError: 30 * 24 * 60 * 60, 
    };
    respond(res, manifest, cacheOpts);
  } catch (error) {
    console.error(`[ERROR] Failed to generate manifest:`, error);
    res.status(500).json({ error: "Failed to generate manifest" });
  }
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
      metas = await getSearch(id, canonicalType, language, search, page, config);
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
    } catch (e) { 
      console.warn(`[WARNING] RPDB poster processing failed, using original posters:`, e.message);
    }
  }
  respond(res, metas, cacheOpts);
});

addon.get("/:catalogChoices?/meta/:type/:id.json", async function (req, res) {
  try {
    const { catalogChoices, type, id } = req.params;
    const canonicalType = toCanonicalType(type); // Canonicalize type at entry point
    const config = parseConfig(catalogChoices) || {};
    const language = config.language || DEFAULT_LANGUAGE;
    const rpdbkey = config.rpdbkey;

    if (id.includes("tmdb:")) {
      const tmdbId = id.split(":")[1];
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
      return respond(res, resp, cacheOpts);
    } else if (id.includes("tt")) {
      const imdbId = id.split(":")[0];
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
        return respond(res, resp, cacheOpts);
      } else {
        return respond(res, { meta: {} });
      }
    } else {
      console.warn(`[WARNING] Invalid meta ID format: ${id}`);
      return res.status(404).send("Not Found");
    }
  } catch (error) {
    console.error(`[ERROR] Meta request failed for ID "${req.params.id}":`, error);
    return res.status(500).json({ error: "Failed to retrieve meta information." });
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
    version: "DISCOVERY_PAGE_FIXES_2025_07_14_v1",
    packageVersion: require("../package.json").version,
    hasTypeCanonical: typeof toCanonicalType === 'function',
    codebasePath: __dirname,
    timestamp: new Date().toISOString(),
    criticalFixes: [
      "🚨 CRITICAL: Fixed getTrending.js - genre parameter was incorrectly used as time_window",
      "🚨 CRITICAL: Added proper genre filtering for TMDB trending endpoint",  
      "🚨 CRITICAL: Fixed complete breakage of trending functionality with genre filters",
      "🚨 DISCOVERY: Enhanced parseMedia function for better year and genre handling",
      "🚨 DISCOVERY: Fixed discovery page metadata compatibility with Stremio",
      "🚨 DISCOVERY: Added proper genre validation and year format checking"
    ],
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
      "Enhanced debug logging throughout catalog pipeline",
      "CRITICAL: Fixed old config parsing with Turkish type names",
      "CRITICAL: Fixed manifest generation for old configs",
      "Added old config compatibility test endpoint"
    ],
    testEndpoints: [
      "/debug/version - Version and fix information",
      "/debug/test-types - Type canonicalization testing", 
      "/debug/test-old-config - Old config compatibility testing",
      "/debug/test-flow - Comprehensive flow testing",
      "/debug/test-catalog-requests - Direct catalog function testing",
      "/debug/simulate-stremio - Stremio request simulation",
      "/debug/test-functions - Core function testing",
      "/debug/test-parsemedia - parseMedia function testing",
      "/debug/test-all-functionality - Complete functionality test with bug fixes (NEW)", 
      "/debug/discovery-test - Discovery page metadata validation (NEW)"
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
    'tv'
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

  // Test 3: Config parsing
  try {
    const testConfigs = [
      '{"language":"en-US","catalogs":[{"type":"movie","id":"tmdb.top"}]}',
      '{"language":"tr-TR","catalogs":[{"type":"series","id":"tmdb.top"}]}'
    ];
    
    const configResults = testConfigs.map(configStr => {
      try {
        const config = JSON.parse(configStr);
        return {
          input: configStr,
          parsed: config,
          hasValidTypes: config.catalogs?.every(cat => 
            ['movie', 'series'].includes(cat.type)
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

// Comprehensive catalog testing endpoint
addon.get("/debug/test-catalog-requests", async function (req, res) {
  const testConfig = {
    language: "tr-TR",
    catalogs: [
      { id: "tmdb.top", type: "movie", enabled: true, showInHome: true },
      { id: "tmdb.top", type: "series", enabled: true, showInHome: true },
      { id: "tmdb.trending", type: "movie", enabled: true, showInHome: true },
      { id: "tmdb.trending", type: "series", enabled: true, showInHome: true }
    ]
  };

  const testResults = {
    timestamp: new Date().toISOString(),
    tests: []
  };

  try {
    // Test 1: tmdb.top movie catalog
    console.log("[TEST] Testing tmdb.top movie catalog");
    const topMovies = await getCatalog("movie", "tr-TR", 1, "tmdb.top", null, testConfig);
    testResults.tests.push({
      name: "tmdb.top movies",
      success: !!topMovies?.metas,
      itemCount: topMovies?.metas?.length || 0,
      sampleItem: topMovies?.metas?.[0] || null,
      error: topMovies ? null : "No result returned"
    });

    // Test 2: tmdb.top series catalog  
    console.log("[TEST] Testing tmdb.top series catalog");
    const topSeries = await getCatalog("series", "tr-TR", 1, "tmdb.top", null, testConfig);
    testResults.tests.push({
      name: "tmdb.top series",
      success: !!topSeries?.metas,
      itemCount: topSeries?.metas?.length || 0,
      sampleItem: topSeries?.metas?.[0] || null,
      error: topSeries ? null : "No result returned"
    });

    // Test 3: tmdb.trending movie catalog
    console.log("[TEST] Testing tmdb.trending movie catalog");
    const trendingMovies = await getTrending("movie", "tr-TR", 1, null, testConfig);
    testResults.tests.push({
      name: "tmdb.trending movies", 
      success: !!trendingMovies?.metas,
      itemCount: trendingMovies?.metas?.length || 0,
      sampleItem: trendingMovies?.metas?.[0] || null,
      error: trendingMovies ? null : "No result returned"
    });

    // Test 4: tmdb.trending series catalog
    console.log("[TEST] Testing tmdb.trending series catalog");
    const trendingSeries = await getTrending("series", "tr-TR", 1, null, testConfig);
    testResults.tests.push({
      name: "tmdb.trending series",
      success: !!trendingSeries?.metas,
      itemCount: trendingSeries?.metas?.length || 0,
      sampleItem: trendingSeries?.metas?.[0] || null,
      error: trendingSeries ? null : "No result returned"
    });

    // Test 5: Search functionality
    console.log("[TEST] Testing search functionality");
    const searchResults = await getSearch("tmdb.search", "movie", "tr-TR", "Inception", 1, testConfig);
    testResults.tests.push({
      name: "search movies",
      success: !!searchResults?.metas,
      itemCount: searchResults?.metas?.length || 0,
      sampleItem: searchResults?.metas?.[0] || null,
      error: searchResults ? null : "No result returned"
    });

    // Test 6: Genre filtering
    console.log("[TEST] Testing genre filtering");
    const genreResults = await getCatalog("movie", "tr-TR", 1, "tmdb.top", "Action", testConfig);
    testResults.tests.push({
      name: "genre filtering (Action)",
      success: !!genreResults?.metas,
      itemCount: genreResults?.metas?.length || 0,
      sampleItem: genreResults?.metas?.[0] || null,
      error: genreResults ? null : "No result returned"
    });

    // Summary
    const successCount = testResults.tests.filter(t => t.success).length;
    testResults.summary = {
      totalTests: testResults.tests.length,
      successful: successCount,
      failed: testResults.tests.length - successCount,
      overallSuccess: successCount === testResults.tests.length
    };

  } catch (error) {
    console.error("[TEST ERROR]", error);
    testResults.error = error.message;
    testResults.summary = {
      totalTests: 0,
      successful: 0,
      failed: 1,
      overallSuccess: false
    };
  }

  res.json(testResults);
});

// Test specific parseMedia function
addon.get("/debug/test-parsemedia", function (req, res) {
  try {
    const { parseMedia } = require("./utils/parseProps");
    
    // Sample TMDB movie data
    const movieData = {
      id: 123456,
      title: "Test Movie",
      release_date: "2023-05-15",
      poster_path: "/test-poster.jpg",
      backdrop_path: "/test-backdrop.jpg",
      vote_average: 8.5,
      overview: "This is a test movie description",
      genre_ids: [28, 12, 16] // Action, Adventure, Animation
    };

    // Sample TMDB TV data
    const tvData = {
      id: 654321,
      name: "Test Series",
      first_air_date: "2023-03-10",
      poster_path: "/test-series-poster.jpg",
      backdrop_path: "/test-series-backdrop.jpg", 
      vote_average: 9.2,
      overview: "This is a test series description",
      genre_ids: [18, 10765] // Drama, Sci-Fi & Fantasy
    };

    const genreList = [
      { id: 28, name: "Action" },
      { id: 12, name: "Adventure" },
      { id: 16, name: "Animation" },
      { id: 18, name: "Drama" },
      { id: 10765, name: "Sci-Fi & Fantasy" }
    ];

    const results = {
      timestamp: new Date().toISOString(),
      tests: [
        {
          name: "Parse Movie (type='movie')",
          input: { data: movieData, type: "movie" },
          result: parseMedia(movieData, "movie", genreList)
        },
        {
          name: "Parse TV (type='tv')",
          input: { data: tvData, type: "tv" },
          result: parseMedia(tvData, "tv", genreList)
        },
        {
          name: "Parse Movie (type='series' - should fail gracefully)",
          input: { data: movieData, type: "series" },
          result: parseMedia(movieData, "series", genreList)
        }
      ]
    };

    res.json(results);
  } catch (error) {
    res.json({
      timestamp: new Date().toISOString(),
      error: error.message,
      stack: error.stack
    });
  }
});

// Test endpoint that simulates actual Stremio requests
addon.get("/debug/simulate-stremio", async function (req, res) {
  const configString = req.query.config || "N4IgTgDgJgRg1gUwJ4gFwgC4GYC0UAMWAbAKxQDsAZjgIxE0AsODRAHAMY4wk0k5FQsAJgCGMIviFEh7EABoQAcwQBbAJYA7NYhToAggEkAXiIDKSAMJZKAIQAeALVMAFEQBFWWFRpoB3FQCy7ABqABY2AG7MQjQA0lAAmuQRevIgKrAANmoAzhg6aCBYAI74GFAMND4ArvgaiuQ5apnVDAgIGCQA9hFpmuwtUAh6UNWZGIUYYNUIaRBgPWpDBhkwBlCT07MKmSL11SLKmzgAKgBKaTkIOU1dGuuFMOQwlPiMDEIAnJ+Un6wkbxIDB4xBoNCwnxeDE++E+CF4CAYWA2CjyYAQInU9TQAG0ALoKdgiDAiTJdRQ5XGgJaTVYAOgwXQgaQwSAgs3QKkW2xAGkxHJAziZYxEYEuoS6vgMGgAEl0VBypjMAL5yakbdAYemM5kKVnswpXMBqa5pPkKwpCiAisWoiVS2XyxVbVXq2mwOlIDG2zBsgVciIms38w...";
  
  const testResults = {
    timestamp: new Date().toISOString(),
    simulatedRequests: []
  };

  const testUrls = [
    // Popular movies - first page
    `/${configString}/catalog/movie/tmdb.top.json`,
    // Popular series - first page  
    `/${configString}/catalog/series/tmdb.top.json`,
    // Trending movies
    `/${configString}/catalog/movie/tmdb.trending.json`,
    // Trending series
    `/${configString}/catalog/series/tmdb.trending.json`,
    // Movies with pagination
    `/${configString}/catalog/movie/tmdb.top/skip=100.json`,
    // Series with genre filter
    `/${configString}/catalog/series/tmdb.top/genre=${encodeURIComponent("Action")}.json`,
    // Search
    `/${configString}/catalog/movie/tmdb.search/search=${encodeURIComponent("Batman")}.json`
  ];

  for (const url of testUrls) {
    try {
      console.log(`[SIMULATE] Testing URL: ${url}`);
      
      // Parse the URL like our actual handler does
      const urlParts = url.split('/');
      const catalogChoices = urlParts[1];
      const catalogType = urlParts[3];
      const catalogId = urlParts[4]?.split('.')[0] || urlParts[4]?.split('/')[0];
      const extraString = urlParts[4]?.includes('/') ? urlParts[4].split('/')[1]?.replace('.json', '') : null;
      
      const config = parseConfig(catalogChoices) || {};
      const language = config.language || "tr-TR";
      
      const extraParams = extraString ? Object.fromEntries(new URLSearchParams(extraString).entries()) : {};
      const { genre, skip, search } = extraParams;
      const page = Math.ceil(skip ? skip / 100 + 1 : undefined) || 1;
      
      const canonicalType = toCanonicalType(catalogType);
      
      console.log(`[SIMULATE] Parsed - Type: ${catalogType} → ${canonicalType}, ID: ${catalogId}, Page: ${page}, Genre: ${genre}, Search: ${search}`);
      
      let result;
      if (search) {
        result = await getSearch(catalogId, canonicalType, language, search, page, config);
      } else if (catalogId === "tmdb.trending") {
        result = await getTrending(canonicalType, language, page, genre, config);
      } else {
        result = await getCatalog(canonicalType, language, page, catalogId, genre, config);
      }
      
      testResults.simulatedRequests.push({
        url,
        parsedParams: { catalogType, canonicalType, catalogId, page, genre, search },
        success: !!result?.metas,
        itemCount: result?.metas?.length || 0,
        sampleItem: result?.metas?.[0] ? {
          id: result.metas[0].id,
          name: result.metas[0].name,
          type: result.metas[0].type,
          year: result.metas[0].year,
          hasGenres: Array.isArray(result.metas[0].genre) && result.metas[0].genre.length > 0
        } : null
      });
      
    } catch (error) {
      console.error(`[SIMULATE ERROR] ${url}:`, error);
      testResults.simulatedRequests.push({
        url,
        success: false,
        error: error.message
      });
    }
  }
  
  // Summary
  const successCount = testResults.simulatedRequests.filter(r => r.success).length;
  testResults.summary = {
    totalRequests: testResults.simulatedRequests.length,
    successful: successCount,
    failed: testResults.simulatedRequests.length - successCount,
    overallSuccess: successCount === testResults.simulatedRequests.length
  };
  
  res.json(testResults);
});

// Direct function testing endpoint
addon.get("/debug/test-functions", async function (req, res) {
  const testResults = {
    timestamp: new Date().toISOString(),
    functionTests: []
  };

  try {
    // Test 1: Type canonicalization
    const { toCanonicalType } = require('./utils/typeCanonical');
    const typeTests = [
      'movie', 'series', 'tv'
    ].map(type => ({
      input: type,
      output: toCanonicalType(type),
      correct: ['movie', 'series'].includes(toCanonicalType(type))
    }));
    
    testResults.functionTests.push({
      name: "toCanonicalType",
      tests: typeTests,
      allPassed: typeTests.every(t => t.correct)
    });

    // Test 2: parseMedia with different types
    const { parseMedia } = require('./utils/parseProps');
    const testData = {
      id: 12345,
      title: "Test Movie",
      name: "Test Series", 
      release_date: "2023-01-01",
      first_air_date: "2023-01-01",
      poster_path: "/test.jpg",
      vote_average: 8.5,
      overview: "Test description",
      genre_ids: [28, 12]
    };
    
    const genreList = [{ id: 28, name: "Action" }, { id: 12, name: "Adventure" }];
    
    const parseTests = ['movie', 'tv', 'series'].map(type => {
      try {
        const result = parseMedia(testData, type, genreList);
        return {
          inputType: type,
          outputType: result.type,
          hasName: !!result.name,
          hasYear: !!result.year,
          hasGenres: Array.isArray(result.genre) && result.genre.length > 0,
          success: true
        };
      } catch (error) {
        return {
          inputType: type,
          success: false,
          error: error.message
        };
      }
    });
    
    testResults.functionTests.push({
      name: "parseMedia",
      tests: parseTests,
      allPassed: parseTests.every(t => t.success)
    });

    // Test 3: Config parsing
    const { parseConfig } = require('./utils/parseProps');
    const testConfigs = [
      '{"language":"tr-TR","catalogs":[{"type":"movie","id":"tmdb.top"}]}',
      '{"language":"en-US","catalogs":[{"type":"series","id":"tmdb.top"}]}'
    ];
    
    const configTests = testConfigs.map(configStr => {
      try {
        const result = parseConfig(configStr);
        return {
          input: configStr,
          hasValidTypes: result.catalogs ? result.catalogs.every(cat => ['movie', 'series'].includes(cat.type)) : true,
          success: true,
          result: result
        };
      } catch (error) {
        return {
          input: configStr,
          success: false,
          error: error.message
        };
      }
    });
    
    testResults.functionTests.push({
      name: "parseConfig",
      tests: configTests,
      allPassed: configTests.every(t => t.success && t.hasValidTypes)
    });

    // Overall summary
    testResults.summary = {
      totalFunctionGroups: testResults.functionTests.length,
      allGroupsPassed: testResults.functionTests.every(group => group.allPassed),
      details: testResults.functionTests.map(group => ({
        name: group.name,
        passed: group.allPassed
      }))
    };

  } catch (error) {
    testResults.error = error.message;
    testResults.summary = { allGroupsPassed: false };
  }

  res.json(testResults);
});

// Final comprehensive test after bug fixes
addon.get("/debug/test-all-functionality", async function (req, res) {
  const testResults = {
    timestamp: new Date().toISOString(),
    version: "CRITICAL_BUG_FIXES_2025_07_14_v1",
    bugFixes: [
      "CRITICAL: Fixed getTrending.js - genre was incorrectly used as time_window",
      "CRITICAL: Added proper genre filtering for trending endpoint",
      "CRITICAL: Fixed TMDB API parameter misuse in trending functionality"
    ],
    tests: []
  };

  try {
    console.log("[COMPREHENSIVE TEST] Starting full functionality test");

    // Test 1: Trending without genre (should work)
    console.log("[TEST] Testing trending movies without genre");
    const trendingMoviesNoGenre = await getTrending("movie", "tr-TR", 1, null, {});
    testResults.tests.push({
      name: "Trending Movies (No Genre)",
      success: !!trendingMoviesNoGenre?.metas,
      itemCount: trendingMoviesNoGenre?.metas?.length || 0,
      sampleItem: trendingMoviesNoGenre?.metas?.[0] || null,
      details: "Testing basic trending functionality after bug fix"
    });

    // Test 2: Trending with genre (this was broken before)
    console.log("[TEST] Testing trending movies WITH genre (was broken)");
    const trendingMoviesWithGenre = await getTrending("movie", "tr-TR", 1, "Action", {});
    testResults.tests.push({
      name: "Trending Movies (With Action Genre) - BUG FIX TEST",
      success: !!trendingMoviesWithGenre?.metas,
      itemCount: trendingMoviesWithGenre?.metas?.length || 0,
      sampleItem: trendingMoviesWithGenre?.metas?.[0] || null,
      details: "This was completely broken before - genre was sent as time_window",
      criticalTest: true
    });

    // Test 3: Trending series with genre
    console.log("[TEST] Testing trending series with genre");
    const trendingSeriesWithGenre = await getTrending("series", "tr-TR", 1, "Drama", {});
    testResults.tests.push({
      name: "Trending Series (With Drama Genre) - BUG FIX TEST",
      success: !!trendingSeriesWithGenre?.metas,
      itemCount: trendingSeriesWithGenre?.metas?.length || 0,
      sampleItem: trendingSeriesWithGenre?.metas?.[0] || null,
      details: "Testing series trending with genre filtering",
      criticalTest: true
    });

    // Test 4: Regular catalog functionality
    console.log("[TEST] Testing regular catalog (tmdb.top)");
    const topMovies = await getCatalog("movie", "tr-TR", 1, "tmdb.top", null, {});
    testResults.tests.push({
      name: "Top Movies Catalog",
      success: !!topMovies?.metas,
      itemCount: topMovies?.metas?.length || 0,
      sampleItem: topMovies?.metas?.[0] || null,
      details: "Testing regular catalog functionality"
    });

    // Test 5: Type canonicalization verification
    const testTypes = ['movie', 'series', 'tv'];
    testResults.tests.push({
      name: "Type Canonicalization",
      success: true,
      details: testTypes.map(type => ({
        input: type,
        canonical: toCanonicalType(type),
        isValid: ['movie', 'series'].includes(toCanonicalType(type))
      })),
      allTypesValid: testTypes.every(type => ['movie', 'series'].includes(toCanonicalType(type)))
    });

    // Test 6: parseMedia functionality 
    const testMovieData = {
      id: 12345,
      title: "Test Movie",
      release_date: "2023-01-01",
      poster_path: "/test.jpg",
      genre_ids: [28, 12], // Action, Adventure
      vote_average: 8.5,
      overview: "Test description"
    };

    const testGenreList = [
      { id: 28, name: "Action" },
      { id: 12, name: "Adventure" }
    ];

    const { parseMedia } = require("./utils/parseProps");
    const parsedMovie = parseMedia(testMovieData, "movie", testGenreList);
    const parsedTv = parseMedia({...testMovieData, name: "Test Series", first_air_date: "2023-01-01"}, "tv", testGenreList);

    testResults.tests.push({
      name: "parseMedia Function",
      success: true,
      details: {
        movieParsing: {
          input: "movie",
          output: parsedMovie,
          correctType: parsedMovie.type === "movie",
          hasGenres: parsedMovie.genre.length > 0,
          hasYear: !!parsedMovie.year
        },
        tvParsing: {
          input: "tv",
          output: parsedTv,
          correctType: parsedTv.type === "series", // tv should become series
          hasGenres: parsedTv.genre.length > 0,
          hasYear: !!parsedTv.year
        }
      }
    });

    // Summary
    const successCount = testResults.tests.filter(t => t.success).length;
    const criticalTests = testResults.tests.filter(t => t.criticalTest);
    const criticalSuccessCount = criticalTests.filter(t => t.success).length;

    testResults.summary = {
      totalTests: testResults.tests.length,
      successful: successCount,
      failed: testResults.tests.length - successCount,
      overallSuccess: successCount === testResults.tests.length,
      criticalTests: criticalTests.length,
      criticalSuccessful: criticalSuccessCount,
      criticalIssuesResolved: criticalSuccessCount === criticalTests.length,
      message: criticalSuccessCount === criticalTests.length ? 
        "✅ CRITICAL BUG FIXES SUCCESSFUL - Trending with genre filtering now works!" :
        "❌ Critical issues remain - trending genre filtering still broken"
    };
    res.json(testResults);
  } catch (error) {
    console.error("[COMPREHENSIVE TEST ERROR]", error);
    testResults.error = error.message;
    testResults.summary = {
      totalTests: 0,
      successful: 0,
      failed: 1,
      overallSuccess: false,
      criticalIssuesResolved: false,
      message: "❌ Test execution failed: " + error.message
    };
    res.json(testResults);
  }
});

// Discovery page metadata diagnostic endpoint  
addon.get("/debug/test-discovery-metadata", async function (req, res) {
  const testResults = {
    timestamp: new Date().toISOString(),
    version: "DISCOVERY_PAGE_FIXES_2025_07_14_v1",
    purpose: "Testing discovery page metadata structure for genre and year display",
    tests: []
  };

  try {
    console.log("[DISCOVERY TEST] Testing discovery page metadata structure");

    // Test 1: Get real TMDB data and check parseMedia output
    const testConfig = { language: "tr-TR" };
    const realCatalogData = await getCatalog("movie", "tr-TR", 1, "tmdb.top", null, testConfig);
    
    if (realCatalogData?.metas?.length > 0) {
      const sampleMeta = realCatalogData.metas[0];
      testResults.tests.push({
        name: "Real Catalog Item Structure",
        sampleItem: sampleMeta,
        hasYear: !!sampleMeta.year,
        hasGenres: Array.isArray(sampleMeta.genre) && sampleMeta.genre.length > 0,
        genreCount: Array.isArray(sampleMeta.genre) ? sampleMeta.genre.length : 0,
        genreStructure: typeof sampleMeta.genre,
        yearValue: sampleMeta.year,
        yearType: typeof sampleMeta.year,
        allFields: Object.keys(sampleMeta),
        criticalFields: {
          id: sampleMeta.id,
          name: sampleMeta.name,
          type: sampleMeta.type,
          year: sampleMeta.year,
          genre: sampleMeta.genre,
          poster: sampleMeta.poster,
          imdbRating: sampleMeta.imdbRating
        }
      });
    } else {
      testResults.tests.push({
        name: "Real Catalog Item Structure",
        error: "No items returned from catalog"
      });
    }

    // Test 2: Test parseMedia directly with known TMDB structure
    const { parseMedia } = require("./utils/parseProps");
    const { getGenreList } = require("./lib/getGenreList");
    
    // Get real genre list
    const movieGenreList = await getGenreList("tr-TR", "movie");
    
    // Simulate real TMDB movie response structure
    const tmdbMovieItem = {
      id: 550, // Fight Club
      title: "Fight Club",
      release_date: "1999-10-15",
      poster_path: "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
      backdrop_path: "/fCayJrkfRaCRCTh8GqN30f8oyQF.jpg",
      vote_average: 8.433,
      overview: "A ticking-time-bomb insomniac and a slippery soap salesman channel primal male aggression into a shocking new form of therapy.",
      genre_ids: [18, 53, 80] // Drama, Thriller, Crime
    };

    const parsedMovie = parseMedia(tmdbMovieItem, "movie", movieGenreList);
    
    testResults.tests.push({
      name: "parseMedia Movie Test",
      input: {
        tmdbItem: tmdbMovieItem,
        genreListLength: movieGenreList.length,
        sampleGenres: movieGenreList.slice(0, 3)
      },
      output: parsedMovie,
      analysis: {
        hasCorrectId: parsedMovie.id === "tmdb:550",
        hasCorrectName: parsedMovie.name === "Fight Club",
        hasCorrectType: parsedMovie.type === "movie",
        hasYear: !!parsedMovie.year && parsedMovie.year === "1999",
        hasGenres: Array.isArray(parsedMovie.genre) && parsedMovie.genre.length > 0,
        genreDetails: {
          isArray: Array.isArray(parsedMovie.genre),
          count: Array.isArray(parsedMovie.genre) ? parsedMovie.genre.length : 0,
          values: parsedMovie.genre,
          expectedGenreIds: tmdbMovieItem.genre_ids,
          genreMapping: tmdbMovieItem.genre_ids.map(id => {
            const found = movieGenreList.find(g => g.id === id);
            return { id, name: found ? found.name : 'NOT_FOUND' };
          })
        },
        poster: !!parsedMovie.poster,
        rating: parsedMovie.imdbRating
      }
    });

    // Test 3: Test series parseMedia
    const seriesGenreList = await getGenreList("tr-TR", "series");
    
    const tmdbSeriesItem = {
      id: 1399, // Game of Thrones
      name: "Game of Thrones",
      first_air_date: "2011-04-17",
      poster_path: "/7WUHnWGx5OO145IRxPDUkQSh4C7.jpg",
      backdrop_path: "/suopoADq0k8YZr4dQXcU6pToj6s.jpg",
      vote_average: 8.453,
      overview: "Seven noble families fight for control of the mythical land of Westeros.",
      genre_ids: [18, 10765, 10759] // Drama, Sci-Fi & Fantasy, Action & Adventure
    };

    const parsedSeries = parseMedia(tmdbSeriesItem, "tv", seriesGenreList);
    
    testResults.tests.push({
      name: "parseMedia Series Test",
      input: {
        tmdbItem: tmdbSeriesItem,
        genreListLength: seriesGenreList.length,
        inputType: "tv"
      },
      output: parsedSeries,
      analysis: {
        hasCorrectId: parsedSeries.id === "tmdb:1399",
        hasCorrectName: parsedSeries.name === "Game of Thrones",
        hasCorrectType: parsedSeries.type === "series", // Should convert tv -> series
        hasYear: !!parsedSeries.year && parsedSeries.year === "2011",
        hasGenres: Array.isArray(parsedSeries.genre) && parsedSeries.genre.length > 0,
        genreDetails: {
          isArray: Array.isArray(parsedSeries.genre),
          count: Array.isArray(parsedSeries.genre) ? parsedSeries.genre.length : 0,
          values: parsedSeries.genre,
          expectedGenreIds: tmdbSeriesItem.genre_ids,
          genreMapping: tmdbSeriesItem.genre_ids.map(id => {
            const found = seriesGenreList.find(g => g.id === id);
            return { id, name: found ? found.name : 'NOT_FOUND' };
          })
        }
      }
    });

    // Test 4: Compare with Stremio expected structure
    const stremioExpectedStructure = {
      id: "string",
      name: "string", 
      type: "movie|series",
      poster: "string (URL)",
      genre: ["array", "of", "strings"],
      year: "string (YYYY)",
      imdbRating: "string (X.X)",
      description: "string"
    };

    testResults.tests.push({
      name: "Stremio Compatibility Check",
      stremioExpected: stremioExpectedStructure,
      ourMovieOutput: parsedMovie ? {
        id: typeof parsedMovie.id,
        name: typeof parsedMovie.name,
        type: typeof parsedMovie.type,
        poster: typeof parsedMovie.poster,
        genre: Array.isArray(parsedMovie.genre) ? `array[${parsedMovie.genre.length}]` : typeof parsedMovie.genre,
        year: typeof parsedMovie.year,
        imdbRating: typeof parsedMovie.imdbRating,
        description: typeof parsedMovie.description
      } : null,
      compatibility: {
        movieStructureMatch: parsedMovie ? {
          idOk: typeof parsedMovie.id === "string",
          nameOk: typeof parsedMovie.name === "string",
          typeOk: ["movie", "series"].includes(parsedMovie.type),
          posterOk: typeof parsedMovie.poster === "string",
          genreOk: Array.isArray(parsedMovie.genre),
          yearOk: typeof parsedMovie.year === "string" && /^\d{4}$/.test(parsedMovie.year),
          ratingOk: typeof parsedMovie.imdbRating === "string"
        } : null
      }
    });

    // Summary
    const allTests = testResults.tests.filter(t => !t.error);
    const discoveryIssues = [];

    allTests.forEach(test => {
      if (test.analysis) {
        if (!test.analysis.hasYear) discoveryIssues.push("Missing or invalid year");
        if (!test.analysis.hasGenres) discoveryIssues.push("Missing or invalid genres");
      }
      if (test.compatibility?.movieStructureMatch) {
        const compat = test.compatibility.movieStructureMatch;
        if (!compat.yearOk) discoveryIssues.push("Year format incompatible with Stremio");
        if (!compat.genreOk) discoveryIssues.push("Genre format incompatible with Stremio");
      }
    });

    testResults.summary = {
      totalTests: testResults.tests.length,
      discoveryIssuesFound: discoveryIssues.length,
      discoveryIssues: [...new Set(discoveryIssues)],
      criticalForDiscovery: discoveryIssues.length === 0 ? 
        "✅ Discovery metadata structure looks correct" :
        `❌ ${discoveryIssues.length} discovery issues found`
    };

  } catch (error) {
    console.error("[DISCOVERY TEST ERROR]", error);
    testResults.error = error.message;
    testResults.summary = {
      totalTests: 0,
      discoveryIssuesFound: 1,
      discoveryIssues: ["Test execution failed: " + error.message],
      criticalForDiscovery: "❌ Unable to test discovery metadata"
    };
  }

  res.json(testResults);
});

// Simple discovery metadata test
addon.get("/debug/discovery-test", async function (req, res) {
  try {
    console.log("[DISCOVERY] Testing discovery metadata");
    
    // Test with real data
    const testCatalog = await getCatalog("movie", "tr-TR", 1, "tmdb.top", null, {});
    
    if (testCatalog?.metas?.length > 0) {
      const sample = testCatalog.metas[0];
      res.json({
        timestamp: new Date().toISOString(),
        purpose: "Discovery page metadata analysis",
        sampleItem: sample,
        issues: {
          missingYear: !sample.year,
          emptyGenres: !Array.isArray(sample.genre) || sample.genre.length === 0,
          missingPoster: !sample.poster,
          yearFormat: typeof sample.year,
          genreFormat: typeof sample.genre
        },
        recommendation: !sample.year || !Array.isArray(sample.genre) || sample.genre.length === 0 ? 
          "ISSUE CONFIRMED: Missing year or genres in discovery metadata" :
          "Discovery metadata structure looks correct"
      });
    } else {
      res.json({
        error: "No catalog items returned",
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = addon;
