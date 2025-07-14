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
    time_window: "day", // Fixed: time_window should always be day/week/month, NOT genre
    language,
    page,
  };

  const genreList = await getGenreList(language, canonicalType);

  return await moviedb
    .trending(parameters)
    .then((res) => {
      let results = res.results;
      
      // Filter by genre if specified (TMDB trending doesn't support genre filtering natively)
      if (genre && genreList.length > 0) {
        const targetGenreId = genreList.find(g => g.name === genre)?.id;
        if (targetGenreId) {
          results = results.filter(item => 
            item.genre_ids && item.genre_ids.includes(targetGenreId)
          );
        }
      }
      
      const metas = results.map(item => {
        // TMDB trending API returns items with media_type field
        const itemType = item.media_type || media_type;
        return parseMedia(item, itemType, genreList);
      });
      return { metas };
    })
    .catch(error => {
      console.error("Error in getTrending:", error);
      throw error;
    });
}

module.exports = { getTrending };
