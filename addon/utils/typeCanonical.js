// Utility to map display label or type to canonical type ("movie" or "series")
const typeLabels = {
  movie: "Detaylı Filtre (Film) 🔎",
  series: "Detaylı Filtre (Dizi) 🔎"
};

const labelToType = {
  [typeLabels.movie]: "movie",
  [typeLabels.series]: "series",
  movie: "movie",
  series: "series",
  tv: "series"  // Handle TMDB API inconsistency
};

function toCanonicalType(input) {
  return labelToType[input] || input;
}

module.exports = { toCanonicalType };
