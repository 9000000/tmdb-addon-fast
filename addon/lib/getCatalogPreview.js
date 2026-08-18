const Utils = require("../utils/parseProps");

async function getCatalogPreview(moviedb, item, type, language, genreList, config = {}) {
  const preview = {
    ...Utils.parseMedia(item, type, genreList),
    poster: await Utils.parseMediaImage(type, item.id, item.poster_path, language,
      config.rpdbkey, "poster", config.rpdbMediaTypes,
      config.topposterskey, config.toppostersConfig)
  };

  try {
    const details = type === "movie"
      ? await moviedb.movieInfo({ id: item.id, language, append_to_response: "credits,external_ids" })
      : await moviedb.tvInfo({ id: item.id, language, append_to_response: "credits,external_ids" });

    const credits = details.credits || { cast: [], crew: [] };
    const castCount = config.castCount !== undefined && Number.isFinite(Number(config.castCount))
      ? Number(config.castCount)
      : undefined;

    const imdbId = details.imdb_id || details.external_ids?.imdb_id;
    const runtime = type === "movie"
      ? details.runtime
      : details.episode_run_time?.[0] ?? details.last_episode_to_air?.runtime ?? details.next_episode_to_air?.runtime;

    return {
      ...preview,
      id: ((config.returnImdbId === true || config.returnImdbId === "true") && imdbId)
        ? imdbId
        : preview.id,
      releaseInfo: type === "movie"
        ? preview.releaseInfo
        : Utils.parseYear(details.status, item.first_air_date, details.last_air_date),
      runtime: Utils.parseRunTime(runtime),
      ...(type === "movie"
        ? { director: Utils.parseDirector(credits), writer: Utils.parseWriter(credits) }
        : { writer: Utils.parseCreatedBy(details.created_by || []) }),
      links: [
        ...(imdbId ? [Utils.parseImdbLink(preview.imdbRating, imdbId)] : []),
        ...Utils.parseCreditsLink(credits, castCount)
      ],
      app_extras: { cast: Utils.parseCast(credits, castCount) }
    };
  } catch (error) {
    console.warn(`Error enriching catalog metadata for ${item.id}:`, error.message);
    return preview;
  }
}

module.exports = { getCatalogPreview };
