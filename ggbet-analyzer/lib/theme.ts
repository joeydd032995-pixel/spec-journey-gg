/* ============================================================================
   Design tokens — single source of truth for color, type and spacing.
   Dark "trading terminal" theme: cool green-tinted neutrals, one accent.
   ========================================================================== */

export const C = {
  // surfaces (green-tinted cool darks, stepped by lightness)
  bg: "#0a0e0d",
  surface: "#101614",
  surface2: "#161e1b",
  surface3: "#1c2622",
  border: "#212c28",
  borderHi: "#2e3c37",
  // text
  text: "#e9f1ec",
  muted: "#8a9c93",
  faint: "#5b6b63",
  // accent + semantic
  accent: "#3df5a0",
  accentDim: "#1c6b48",
  accentBg: "#0c2a1d",
  pos: "#3df5a0",
  neg: "#ff5d52",
  negBg: "#2e1210",
  amber: "#ffc24b",
  amberBg: "#2c2310",
  blue: "#5fb0ff",
  blueBg: "#0f2334",
} as const;

export const FONT = {
  ui: "'Archivo', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

/** 4px spacing scale — the only spacing values used in the UI. */
export const SP = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const RADIUS = { sm: 6, md: 8, lg: 12 } as const;
