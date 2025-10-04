// Utility to map display label or type to canonical type ("movie" or "series")
const labelToType = {
  movie: "movie",
  series: "series",
  tv: "series"  // Handle TMDB API inconsistency
};

function toCanonicalType(input) {
  return labelToType[input] || input;
}

module.exports = { toCanonicalType };