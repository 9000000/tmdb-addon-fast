// Type labels mapping for display purposes (does not affect API type values)
// This mapping ensures consistent labels across the frontend UI
export const TYPE_LABELS = {
  movie: "Movie",
  series: "Series"
} as const;

export type ContentType = keyof typeof TYPE_LABELS;