require("dotenv").config();
const { MovieDb } = require("moviedb-promise");
const moviedb = new MovieDb(process.env.TMDB_API);
const { parseMedia } = require("../utils/parseProps");
const { getGenreList } = require("./getGenreList");
const { toCanonicalType } = require("../utils/typeCanonical");

async function getTrending(type, language, page, genre, config) {
  const canonicalType = toCanonicalType(type);
  const media_type = canonicalType === "series" ? "tv" : "movie";
  const parameters = {
    media_type,
    time_window: genre ? genre.toLowerCase() : "day",
    language,
    page,
  };

  const genreList = await getGenreList(language, canonicalType);

  return await moviedb
    .trending(parameters)
    .then((res) => {
      const metas = res.results.map(item => {
        // TMDB trending API returns items with media_type field
        const itemType = item.media_type || media_type;
        return parseMedia(item, itemType, genreList);
      });
      return { metas };
    })
    .catch(console.error);
}

module.exports = { getTrending };
