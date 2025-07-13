// Utility to map display label or type to canonical type ("movie" or "series")
import { TYPE_LABELS } from "./typeLabels";

const labelToType: Record<string, "movie" | "series"> = {
  [TYPE_LABELS.movie]: "movie",
  [TYPE_LABELS.series]: "series",
  movie: "movie",
  series: "series",
  tv: "series"  // Handle TMDB API inconsistency
};

/**
 * Returns the canonical type ("movie" or "series") for any input (label or type).
 * Defaults to input if not found.
 */
export function toCanonicalType(input: string): "movie" | "series" | string {
  return labelToType[input] || input;
}
