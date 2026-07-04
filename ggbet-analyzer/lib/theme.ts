/* ============================================================================
   Design tokens — single source of truth for color, type and spacing.
   "Editorial Light" theme: warm paper surfaces, near-black ink, one deep
   cobalt accent. Attention from bold type + soft depth, never neon/glow.
   ========================================================================== */

export const C = {
  // surfaces (warm paper, stepped by lightness — cool-neutral, not cream)
  bg: "#F7F5F0",
  surface: "#FFFFFF",
  surface2: "#F1EEE7",
  surface3: "#E9E5DC",
  border: "#E4DFD5",
  borderHi: "#CFC7B8",
  // text (ink → muted → faint)
  text: "#16181D",
  muted: "#585C66",
  faint: "#8B8F99",
  // accent (deep cobalt) + the color placed on top of it
  accent: "#2540E8",
  accentDim: "#1B2FA8",
  accentBg: "#E7EAFD",
  onAccent: "#FFFFFF",
  // semantic — deliberately non-neon, all AA on paper/white
  pos: "#127A4A",
  posBg: "#E3F3EA",
  neg: "#C42B1C",
  negBg: "#FBE7E4",
  amber: "#B5730B",
  amberBg: "#F7EDD8",
  blue: "#1D6FD1",
  blueBg: "#E5EFFB",
} as const;

export const FONT = {
  ui: "'Archivo', system-ui, sans-serif",
  display: "'Archivo', system-ui, sans-serif", // used at 800–900 weight for headings
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

/* 4px spacing scale — the only spacing values used in the UI. */
export const SP = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const RADIUS = { sm: 6, md: 8, lg: 12 } as const;

/* Depth: top-down light source. Each shadow justifies one z-level.
   Replaces the old neon glow strings. */
export const SHADOW = {
  sm: "0 1px 2px rgba(22,24,29,.06)",
  md: "0 4px 6px rgba(22,24,29,.07), 0 1px 3px rgba(22,24,29,.06)",
  lg: "0 10px 20px -8px rgba(22,24,29,.14), 0 4px 6px rgba(22,24,29,.05)",
} as const;
