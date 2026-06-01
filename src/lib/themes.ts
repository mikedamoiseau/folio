// ── Theme types & presets ────────────────────────────────────

export const TOKEN_NAMES = [
  "paper", "surface", "ink", "ink-muted",
  "warm-border", "warm-subtle", "accent", "accent-hover", "accent-light",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type ColorTokens = Record<TokenName, string>;

export const COLOR_MODES = ["light", "dark", "system", "sepia", "custom"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export function isValidColorMode(value: string): value is ColorMode {
  return (COLOR_MODES as readonly string[]).includes(value);
}

// ── Preset palettes ─────────────────────────────────────────

export const LIGHT_TOKENS: ColorTokens = {
  "paper":        "#faf8f3",
  "surface":      "#ffffff",
  "ink":          "#2c2218",
  "ink-muted":    "#8c7b6e",
  "warm-border":  "#e5ddd4",
  "warm-subtle":  "#f0ead8",
  "accent":       "#c2714e",
  "accent-hover": "#a85f3f",
  "accent-light": "#f7ede6",
};

export const DARK_TOKENS: ColorTokens = {
  "paper":        "#1a1614",
  "surface":      "#231f1b",
  "ink":          "#e8e2d9",
  "ink-muted":    "#9c8e83",
  "warm-border":  "#3a3028",
  "warm-subtle":  "#2a2420",
  "accent":       "#d4886a",
  "accent-hover": "#c27050",
  "accent-light": "#2e1f17",
};

export const SEPIA_TOKENS: ColorTokens = {
  "paper":        "#f0e4ce",
  "surface":      "#e8d9bc",
  "ink":          "#3b2510",
  "ink-muted":    "#7a5c3e",
  "warm-border":  "#d4bfa0",
  "warm-subtle":  "#e4d4b8",
  "accent":       "#9c5a2e",
  "accent-hover": "#7d4523",
  "accent-light": "#f2e4d0",
};

export const DEFAULT_CUSTOM_TOKENS: ColorTokens = { ...SEPIA_TOKENS };

// ── Color math helpers ──────────────────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    "#" +
    [clamp(r), clamp(g), clamp(b)]
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("")
  );
}

export function mixColors(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(
    ar + (br - ar) * t,
    ag + (bg - ag) * t,
    ab + (bb - ab) * t,
  );
}

/** Derive all 9 tokens from a background (paper) and text (ink) color. */
export function deriveTokensFromBase(paper: string, ink: string): ColorTokens {
  return {
    "paper":        paper,
    "surface":      mixColors(paper, ink, 0.06),
    "ink":          ink,
    "ink-muted":    mixColors(paper, ink, 0.45),
    "warm-border":  mixColors(paper, ink, 0.18),
    "warm-subtle":  mixColors(paper, ink, 0.08),
    "accent":       mixColors(paper, ink, 0.55),
    "accent-hover": mixColors(paper, ink, 0.65),
    "accent-light": mixColors(paper, ink, 0.05),
  };
}

// ── DOM application ─────────────────────────────────────────

export function applyTokensToRoot(tokens: ColorTokens): void {
  const root = document.documentElement;
  for (const name of TOKEN_NAMES) {
    root.style.setProperty(`--${name}`, tokens[name]);
  }
}

export function clearRootTokens(): void {
  const root = document.documentElement;
  for (const name of TOKEN_NAMES) {
    root.style.removeProperty(`--${name}`);
  }
}

// ── Built-in reading fonts ──────────────────────────────────

export interface FontOption {
  key: string;
  label: string;
  css: string;
}

export const FONT_OPTIONS: readonly FontOption[] = [
  { key: "serif", label: "Lora", css: '"Lora Variable", Georgia, serif' },
  { key: "literata", label: "Literata", css: '"Literata Variable", Georgia, serif' },
  { key: "sans-serif", label: "DM Sans", css: '"DM Sans Variable", system-ui, sans-serif' },
  { key: "dyslexic", label: "OpenDyslexic", css: '"OpenDyslexic", sans-serif' },
] as const;
