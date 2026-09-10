/* ============================================================================
   Design tokens — single source of truth for color, type and spacing.
   Dark "trading terminal" theme: midnight navy surfaces, violet and blue accents.
   ========================================================================== */

export const C = {
  // surfaces (navy darks, stepped by lightness)
  bg: "#090b18",
  surface: "#11152a",
  surface2: "#191e38",
  surface3: "#222947",
  border: "#303858",
  borderHi: "#444f78",
  // text
  text: "#e5e7ff",
  muted: "#a2acd2",
  faint: "#7e8bb5",
  // accent + semantic
  accent: "#aa91ff",
  accentDim: "#645099",
  accentBg: "#282044",
  pos: "#aa91ff",
  neg: "#ff7b95",
  negBg: "#331b30",
  amber: "#ffc24b",
  amberBg: "#2c2310",
  blue: "#78baff",
  blueBg: "#182c49",
} as const;

export const FONT = {
  ui: "'Archivo', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

/** 4px spacing scale — the only spacing values used in the UI. */
export const SP = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const RADIUS = { sm: 6, md: 8, lg: 12 } as const;
