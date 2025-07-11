require("dotenv").config();
const { MovieDb } = require("moviedb-promise");
const moviedb = new MovieDb(process.env.TMDB_API);
const { parseMedia } = require("../utils/parseProps");
const { getGenreList } = require("./getGenreList");

async function getTrending(type, language, page, genre, config) {
  const media_type = type === "series" ? "tv" : type;
  const parameters = {
    media_type,
    time_window: genre ? genre.toLowerCase() : "day",
    language,
    page,
  };

  const genreList = await getGenreList(language, type);

  return await moviedb
    .trending(parameters)
    .then((res) => {
      const metas = res.results.map(item => parseMedia(item, type, genreList));
      return { metas };
    })
    .catch(console.error);
}

module.exports = { getTrending };
