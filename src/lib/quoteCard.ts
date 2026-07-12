// Pure layout logic + thin canvas draw for shareable highlight "quote cards"
// (F-1-6). Split so the hard part — text fitting/wrapping — is pure and
// unit-tested; only `drawCard`/`renderCardToCanvas` touch the DOM/canvas.
//
// See docs/superpowers/specs/2026-07-12-highlight-quote-cards-design.md.

// ── Card geometry ────────────────────────────────────────────

/** Card size in CSS px; the backing store renders at `CARD_W*SCALE x CARD_H*SCALE`. */
export const CARD_W = 1080;
export const CARD_H = 1350;
/** Backing-store scale factor for retina-crisp exports. */
export const SCALE = 2;

/** Horizontal margin either side of the quote/footer content. */
const CONTENT_PADDING_X = 96;
/** Width available to the wrapped quote text. */
export const QUOTE_BOX_WIDTH_PX = CARD_W - CONTENT_PADDING_X * 2;

export const MIN_QUOTE_PX = 28;
export const MAX_QUOTE_PX = 64;
const FONT_STEP_PX = 2;
export const MAX_LINES = 8;
/** Hard cap on quote length before layout — a pathological selection can't blow up the fit loop. */
export const MAX_QUOTE_CHARS = 600;
/** Rough average glyph width as a fraction of font size, used only to pick a font size — `ctx.measureText` does the precise draw-time positioning. */
const AVG_GLYPH_RATIO = 0.55;

// ── Style presets ────────────────────────────────────────────

export type CardStyle = "light" | "sepia" | "dark";

export interface CardPalette {
  bg: string;
  ink: string;
  inkMuted: string;
  accent: string;
}

/**
 * Three fixed, tuned card palettes — deliberately NOT the reader's live
 * theme tokens (the reader also has a Custom mode with arbitrary CSS we
 * don't want to rasterize into a shared image).
 */
export const CARD_STYLES: Record<CardStyle, CardPalette> = {
  light: { bg: "#faf8f3", ink: "#2c2218", inkMuted: "#8c7b6e", accent: "#c2714e" },
  sepia: { bg: "#f0e4ce", ink: "#3b2510", inkMuted: "#7a5c3e", accent: "#9c5a2e" },
  dark: { bg: "#1a1614", ink: "#e8e2d9", inkMuted: "#9c8e83", accent: "#d4886a" },
};

/** Reader color mode -> default card style. Custom (arbitrary CSS) maps to light. */
export function defaultStyleForMode(mode: string): CardStyle {
  if (mode === "dark") return "dark";
  if (mode === "sepia") return "sepia";
  return "light"; // light, system, custom, and anything unrecognized
}

// ── Card input ───────────────────────────────────────────────

export interface CardInput {
  quote: string;
  title: string;
  author: string;
  style: CardStyle;
  includeCover: boolean;
  includeWordmark: boolean;
}

// ── Pure layout functions (unit-tested, no canvas/DOM) ───────

/**
 * Collapse all whitespace/newlines in a raw selection/highlight to single
 * spaces, trim, and hard-cap to `MAX_QUOTE_CHARS` so a pathological
 * selection can't blow up the fit loop below.
 */
export function sanitizeQuoteForCard(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_QUOTE_CHARS ? collapsed.slice(0, MAX_QUOTE_CHARS) : collapsed;
}

/**
 * Greedy word-wrap: pack as many whitespace-separated words per line as fit
 * within `maxCharsPerLine`. A single word longer than the line budget is
 * hard-split across multiple lines (no hyphenation — layout approximation,
 * not typography).
 */
export function wrapText(text: string, maxCharsPerLine: number): string[] {
  const budget = Math.max(1, Math.floor(maxCharsPerLine));
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > budget) {
      if (current) {
        lines.push(current);
        current = "";
      }
      let remaining = word;
      while (remaining.length > budget) {
        lines.push(remaining.slice(0, budget));
        remaining = remaining.slice(budget);
      }
      current = remaining;
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= budget) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  return lines;
}

export interface FitQuoteResult {
  fontSize: number;
  lines: string[];
  truncated: boolean;
}

export interface FitQuoteOptions {
  /** Width available to the wrapped text, in px. Defaults to `QUOTE_BOX_WIDTH_PX`. */
  boxWidthPx?: number;
  /** Max number of lines before truncation kicks in. Defaults to `MAX_LINES`. */
  maxLines?: number;
}

/**
 * Choose the largest font size in `[MIN_QUOTE_PX, MAX_QUOTE_PX]` (stepping
 * down) whose wrapped quote fits within `maxLines`. Chars-per-line at a
 * given size is derived from `boxWidthPx / (fontSize * AVG_GLYPH_RATIO)` —
 * an approximation good enough to pick a size; `drawCard` uses
 * `ctx.measureText` for the actual draw-time positioning.
 *
 * If even `MIN_QUOTE_PX` overflows `maxLines`, keep the first `maxLines`
 * lines, append "…" to the last one, and set `truncated: true`.
 *
 * Deterministic: same inputs always produce the same output.
 */
export function fitQuote(quote: string, opts: FitQuoteOptions = {}): FitQuoteResult {
  const boxWidthPx = opts.boxWidthPx ?? QUOTE_BOX_WIDTH_PX;
  const maxLines = opts.maxLines ?? MAX_LINES;

  const charsPerLineAt = (fontSize: number) =>
    Math.max(1, Math.floor(boxWidthPx / (fontSize * AVG_GLYPH_RATIO)));

  for (let fontSize = MAX_QUOTE_PX; fontSize >= MIN_QUOTE_PX; fontSize -= FONT_STEP_PX) {
    const lines = wrapText(quote, charsPerLineAt(fontSize));
    if (lines.length <= maxLines) {
      return { fontSize, lines, truncated: false };
    }
  }

  // Still overflows at MIN_QUOTE_PX: hard-truncate with a trailing ellipsis.
  const lines = wrapText(quote, charsPerLineAt(MIN_QUOTE_PX)).slice(0, maxLines);
  const lastIndex = lines.length - 1;
  if (lastIndex >= 0) {
    lines[lastIndex] = `${lines[lastIndex].trimEnd()}…`;
  }
  return { fontSize: MIN_QUOTE_PX, lines, truncated: true };
}

// ── Canvas draw (impure — not unit-tested; canvas isn't available in jsdom) ──

const QUOTE_FONT_STACK = "'Playfair Display Variable', Georgia, serif";
const FOOTER_FONT_STACK = "'DM Sans Variable', system-ui, -apple-system, sans-serif";
const COVER_BOX_SIZE = 108;
const COVER_BOX_RADIUS = 10;
const FOOTER_BOTTOM_Y = CARD_H - 90;
const WORDMARK_TEXT = "Folio";

function drawCoverThumb(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number) {
  const size = COVER_BOX_SIZE;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + COVER_BOX_RADIUS, y);
  ctx.arcTo(x + size, y, x + size, y + size, COVER_BOX_RADIUS);
  ctx.arcTo(x + size, y + size, x, y + size, COVER_BOX_RADIUS);
  ctx.arcTo(x, y + size, x, y, COVER_BOX_RADIUS);
  ctx.arcTo(x, y, x + size, y, COVER_BOX_RADIUS);
  ctx.closePath();
  ctx.clip();

  // object-fit: cover — crop to the box's aspect ratio, never stretch.
  const imgW = img.naturalWidth || img.width;
  const imgH = img.naturalHeight || img.height;
  const scale = Math.max(size / imgW, size / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const drawX = x + (size - drawW) / 2;
  const drawY = y + (size - drawH) / 2;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  ctx.restore();
}

/**
 * Fill background, draw the wrapped quote (sized via `fitQuote`), and the
 * footer: optional cover thumbnail, title, author (omitted entirely when
 * empty — no dangling "— , Title"), and an optional low-contrast wordmark.
 * Assumes fonts are already loaded (caller awaits `document.fonts.ready`).
 */
export function drawCard(ctx: CanvasRenderingContext2D, input: CardInput, coverImg: HTMLImageElement | null): void {
  const palette = CARD_STYLES[input.style];

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Quote
  const { fontSize, lines } = fitQuote(input.quote);
  const lineHeight = fontSize * 1.35;
  const quoteBlockHeight = lines.length * lineHeight;
  const quoteTop = Math.max(140, (CARD_H - 260 - quoteBlockHeight) / 2);

  ctx.fillStyle = palette.ink;
  ctx.font = `italic 600 ${fontSize}px ${QUOTE_FONT_STACK}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  lines.forEach((line, i) => {
    ctx.fillText(line, CONTENT_PADDING_X, quoteTop + (i + 1) * lineHeight - lineHeight * 0.25);
  });

  // Footer
  const showCover = input.includeCover && coverImg !== null;
  const footerTextX = showCover ? CONTENT_PADDING_X + COVER_BOX_SIZE + 24 : CONTENT_PADDING_X;

  if (showCover && coverImg) {
    drawCoverThumb(ctx, coverImg, CONTENT_PADDING_X, FOOTER_BOTTOM_Y - COVER_BOX_SIZE + 8);
  }

  const hasAuthor = input.author.trim().length > 0;
  ctx.textAlign = "left";
  ctx.fillStyle = palette.ink;
  ctx.font = `700 30px ${FOOTER_FONT_STACK}`;
  ctx.fillText(input.title, footerTextX, hasAuthor ? FOOTER_BOTTOM_Y - 14 : FOOTER_BOTTOM_Y);

  if (hasAuthor) {
    ctx.fillStyle = palette.inkMuted;
    ctx.font = `400 24px ${FOOTER_FONT_STACK}`;
    ctx.fillText(input.author, footerTextX, FOOTER_BOTTOM_Y + 24);
  }

  if (input.includeWordmark) {
    ctx.textAlign = "right";
    ctx.fillStyle = palette.accent;
    ctx.globalAlpha = 0.55;
    ctx.font = `600 22px ${FOOTER_FONT_STACK}`;
    ctx.fillText(WORDMARK_TEXT, CARD_W - CONTENT_PADDING_X, CARD_H - 40);
    ctx.globalAlpha = 1;
  }
}

/**
 * Render a full quote card into a fresh offscreen canvas at `CARD_W*SCALE x
 * CARD_H*SCALE` (2x backing store for retina-crisp exports). Used for both
 * the dialog's live preview and the final export (`toBlob`/`getImageData`).
 */
export function renderCardToCanvas(input: CardInput, coverImg: HTMLImageElement | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W * SCALE;
  canvas.height = CARD_H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.scale(SCALE, SCALE);
  drawCard(ctx, input, coverImg);
  return canvas;
}
