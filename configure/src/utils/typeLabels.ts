// Type labels mapping for display purposes (does not affect API type values)
// This mapping ensures consistent Turkish labels across the frontend UI
export const TYPE_LABELS = {
  movie: "Detaylı Filtre (Film) 🔎",
  series: "Detaylı Filtre (Dizi) 🔎"
} as const;

export type ContentType = keyof typeof TYPE_LABELS;