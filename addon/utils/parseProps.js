const urlExists = require("url-exists");
const { decompressFromEncodedURIComponent } = require('lz-string');
const { toCanonicalType } = require("./typeCanonical");

function parseCertification(release_dates, language) {
  return release_dates.results.filter(
    (releases) => releases.iso_3166_1 == language.split("-")[1]
  )[0].release_dates[0].certification;
}

function parseCast(credits, count) {
  if (count === undefined || count === null) {
    return credits.cast.map((el) => {
      return {
        name: el.name,
        character: el.character,
        photo: el.profile_path ? `https://image.tmdb.org/t/p/w276_and_h350_face${el.profile_path}` : null
      };
    });
  }
  return credits.cast.slice(0, count).map((el) => {
    return {
      name: el.name,
      character: el.character,
      photo: el.profile_path ? `https://image.tmdb.org/t/p/w276_and_h350_face${el.profile_path}` : null
    };
  });
}

function parseDirector(credits) {
  return credits.crew
    .filter((x) => x.job === "Director")
    .map((el) => {
      return el.name;
    });
}

function parseWriter(credits) {
  return credits.crew
    .filter((x) => x.job === "Writer")
    .map((el) => {
      return el.name;
    });
}

function parseSlug(type, title, imdb_id) {
  const canonicalType = toCanonicalType(type);
  if (canonicalType !== "movie" && canonicalType !== "series") {
    console.error(`[ERROR] Unexpected canonical type in parseSlug: ${canonicalType}`);
  }
  return `${canonicalType}/${title.toLowerCase().replace(/ /g, "-")}-${imdb_id ? imdb_id.replace("tt", "") : ""}`;
}

function parseTrailers(videos) {
  return videos.results
    .filter((el) => el.site === "YouTube")
    .filter((el) => el.type === "Trailer")
    .map((el) => {
      return {
        source: `${el.key}`,
        type: `${el.type}`,
      };
    });
}

function parseTrailerStream(videos) {
  return videos.results
    .filter((el) => el.site === "YouTube")
    .filter((el) => el.type === "Trailer")
    .map((el) => {
      return {
        title: `${el.name}`,
        ytId: `${el.key}`,
      };
    });
}

function parseImdbLink(vote_average, imdb_id) {
  return {
    name: vote_average,
    category: "imdb",
    url: `https://imdb.com/title/${imdb_id}`,
  };
}

function parseShareLink(title, id, type) {
  const canonicalType = toCanonicalType(type);
  if (canonicalType !== "movie" && canonicalType !== "series") {
    console.error(`[ERROR] Unexpected canonical type in parseShareLink: ${canonicalType}`);
  }
  return {
    name: title,
    category: "share",
    url: `https://web.stremio.com/#/detail/${canonicalType}/${id}`,
  };
}

function parseGenreLink(genres, type, language) {
  const canonicalType = toCanonicalType(type);
  if (canonicalType !== "movie" && canonicalType !== "series") {
    console.error(`[ERROR] Unexpected canonical type in parseGenreLink: ${canonicalType}`);
  }
  return genres.map((genre) => {
    return {
      name: genre.name,
      category: "Genres",
      url: `stremio:///discover/${encodeURIComponent(
        process.env.HOST_NAME
      )}%2F${language}%2Fmanifest.json/${canonicalType}/tmdb.top?genre=${encodeURIComponent(
        genre.name
      )}`,
    };
  });
}

function parseCreditsLink(credits) {
  const castData = parseCast(credits, 10);
  const Cast = castData.map((actor) => {
    return {
      name: actor.name,
      category: "Cast",
      url: `stremio:///search?search=${encodeURIComponent(actor.name)}`
    };
  });
  const Director = parseDirector(credits).map((director) => {
    return {
      name: director,
      category: "Directors",
      url: `stremio:///search?search=${encodeURIComponent(director)}`,
    };
  });
  const Writer = parseWriter(credits).map((writer) => {
    return {
      name: writer,
      category: "Writers",
      url: `stremio:///search?search=${encodeURIComponent(writer)}`,
    };
  });
  return new Array(...Cast, ...Director, ...Writer);
}

function parseCoutry(production_countries) {
  return production_countries.map((country) => country.name).join(", ");
}

function parseGenres(genres) {
  return genres.map((el) => {
    return el.name;
  });
}

function parseYear(status, first_air_date, last_air_date) {
  if (status === "Ended") {
    return first_air_date && last_air_date
      ? first_air_date.substr(0, 5) + last_air_date.substr(0, 4)
      : "";
  } else {
    return first_air_date ? first_air_date.substr(0, 5) : "";
  }
}

function parseRunTime(runtime) {
  if (runtime === 0 || !runtime) {
    return "";
  }
  
  const hours = Math.floor(runtime / 60);
  const minutes = runtime % 60;

  if (runtime > 60) {
    return hours > 0 ? `${hours}h${minutes}min` : `${minutes}min`;
  } else {
    return `${runtime}min`;
  }
}

function parseCreatedBy(created_by) {
  return created_by.map((el) => el.name);
}

function parseConfig(catalogChoices) {
  let config = {};
  
  if (!catalogChoices) {
    return config;
  }
  
  try {
    const decoded = decompressFromEncodedURIComponent(catalogChoices);
    config = JSON.parse(decoded);
  } catch (e) {
    try {
      config = JSON.parse(catalogChoices);
    } catch {
      if (catalogChoices) {
        config.language = catalogChoices;
      }
    }
  }
  
  // Normalize old configs with Turkish type names
  if (config.catalogs && Array.isArray(config.catalogs)) {
    config.catalogs = config.catalogs.map(catalog => ({
      ...catalog,
      type: toCanonicalType(catalog.type) // Canonicalize types from old configs
    }));
  }
  
  return config;
}

async function parsePoster(type, id, poster, language, rpdbkey) {
  const canonicalType = toCanonicalType(type);
  if (canonicalType !== "movie" && canonicalType !== "series") {
    console.error(`[ERROR] Unexpected canonical type in parsePoster: ${canonicalType}`);
  }
  const tmdbImage = `https://image.tmdb.org/t/p/w500${poster}`
  if (rpdbkey) {
    const rpdbImage = getRpdbPoster(canonicalType, id, language, rpdbkey)
    return await checkIfExists(rpdbImage) ? rpdbImage : tmdbImage;
  }
  return tmdbImage;
}

function parseMedia(el, type, genreList = []) {
  try {
    // Handle TMDB API type inconsistency: 'tv' should be treated as 'series'
    let normalizedType = type;
    if (type === 'tv') normalizedType = 'series';
    
    const canonicalType = toCanonicalType(normalizedType);
    if (canonicalType !== "movie" && canonicalType !== "series") {
      console.error(`[ERROR] Unexpected canonical type in parseMedia: ${canonicalType}, original type: ${type}`);
    }
    
    // Safe genre parsing with error handling
    let genres = [];
    if (Array.isArray(el.genre_ids) && genreList.length > 0) {
      genres = el.genre_ids.map(genreId => {
        const found = genreList.find(g => g.id === genreId);
        return found ? found.name : null;
      }).filter(name => name !== null); // Remove null genres, keep valid ones
      
      // If no genres were found but genre_ids exist, log for debugging
      if (genres.length === 0 && el.genre_ids.length > 0) {
        console.warn(`[WARNING] No genre names found for genre_ids: ${el.genre_ids} in item ${el.id}`);
      }
    }

    // Ensure year is always a string and properly formatted
    let year = '';
    if (canonicalType === 'movie' && el.release_date) {
      year = el.release_date.substr(0, 4);
    } else if (canonicalType === 'series' && el.first_air_date) {
      year = el.first_air_date.substr(0, 4);
    }
    
    // Validate year format for discovery page compatibility
    if (year && !/^\d{4}$/.test(year)) {
      console.warn(`[WARNING] Invalid year format: ${year} for item ${el.id}`);
      year = '';
    }

    return {
      id: `tmdb:${el.id}`,
      name: el.title || el.name || 'Unknown Title',
      genre: genres, // Array of genre strings, properly filtered
      poster: el.poster_path ? `https://image.tmdb.org/t/p/w500${el.poster_path}` : null,
      background: el.backdrop_path ? `https://image.tmdb.org/t/p/original${el.backdrop_path}` : null,
      posterShape: "regular",
      imdbRating: el.vote_average ? el.vote_average.toFixed(1) : 'N/A',
      year: year, // Properly validated year string
      type: canonicalType,
      description: el.overview || '',
    };
  } catch (error) {
    console.error(`[ERROR] Failed to parse media item:`, error, 'Item:', el);
    // Return a minimal valid object
    return {
      id: `tmdb:${el.id || 'unknown'}`,
      name: el.title || el.name || 'Error parsing item',
      genre: [],
      poster: null,
      background: null,
      posterShape: "regular",
      imdbRating: 'N/A',
      year: '',
      type: toCanonicalType(type),
      description: 'Error occurred while parsing this item',
    };
  }
}

function getRpdbPoster(type, id, language, rpdbkey) {
  const canonicalType = toCanonicalType(type);
  if (canonicalType !== "movie" && canonicalType !== "series") {
    console.error(`[ERROR] Unexpected canonical type in getRpdbPoster: ${canonicalType}`);
  }
  if (!rpdbkey) return null;
  const tier = rpdbkey.split("-")[0];
  const lang = language.split("-")[0];
  if (tier === "t0" || tier === "t1" || lang === "en") {
    return `https://api.ratingposterdb.com/${rpdbkey}/tmdb/poster-default/${canonicalType}-${id}.jpg?fallback=true`;
  } else {
    return `https://api.ratingposterdb.com/${rpdbkey}/tmdb/poster-default/${canonicalType}-${id}.jpg?fallback=true&lang=${lang}`;
  }
}

async function checkIfExists(rpdbImage) {
  return new Promise((resolve) => {
    urlExists(rpdbImage, (err, exists) => {
      if (exists) {
        resolve(true)
      } else {
        resolve(false);
      }
    })
  });
}

module.exports = {
  parseCertification,
  parseCast,
  parseDirector,
  parseSlug,
  parseWriter,
  parseTrailers,
  parseTrailerStream,
  parseImdbLink,
  parseShareLink,
  parseGenreLink,
  parseCreditsLink,
  parseCoutry,
  parseGenres,
  parseYear,
  parseRunTime,
  parseCreatedBy,
  parseConfig,
  parsePoster,
  parseMedia,
  getRpdbPoster,
  checkIfExists
};
