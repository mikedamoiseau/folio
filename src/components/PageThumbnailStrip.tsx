import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { blobUrlFromBytes } from "../lib/pageWire";

const THUMB_WIDTH = 80;
const THUMB_HEIGHT = 112;
const GAP = 4;
const ITEM_STRIDE = THUMB_WIDTH + GAP;
const OVERSCAN = 4;
const CACHE_LIMIT = 80;
// Tiles to prefetch (no DOM, just kick off the byte fetch) ahead of
// the visible window in the current scroll direction. Tuned so a fast
// pan keeps the next viewport already decoded by the time it lands.
const PREFETCH_AHEAD = 16;

// ─── Module-level thumbnail cache ──────────────────────────────────
// Surviving instances of the strip share a per-book cache so that
// closing the strip and reopening it does not re-decode every page.
// One book's worth of state lives at a time; activating a different
// book evicts the prior one's blobs (and bumps its generation, so
// any still-pending fetches drop on resolution).
type BookCache = {
  urls: Map<number, string>;
  inflight: Set<number>;
  errors: Set<number>;
  generation: number;
};

const bookCaches = new Map<string, BookCache>();

function getBookCache(bookId: string): BookCache {
  let c = bookCaches.get(bookId);
  if (!c) {
    c = { urls: new Map(), inflight: new Set(), errors: new Set(), generation: 0 };
    bookCaches.set(bookId, c);
  }
  return c;
}

function evictBookCache(bookId: string) {
  const c = bookCaches.get(bookId);
  if (!c) return;
  c.generation += 1;
  for (const url of c.urls.values()) URL.revokeObjectURL(url);
  c.urls.clear();
  c.inflight.clear();
  c.errors.clear();
  bookCaches.delete(bookId);
}

/**
 * Compute which thumbnail indices intersect the visible scroll window.
 *
 * Pure function so the strip can be unit-tested without DOM. The
 * caller passes the current `scrollLeft`, the viewport `width`, the
 * fixed item stride (thumb width + gap), the total `count` of thumbs,
 * and an `overscan` number of off-screen thumbs to keep mounted for
 * smooth scrolling. Returns half-open `[start, end)` indices clamped
 * to `[0, count]`. If `count === 0`, returns an empty range.
 */
export function computeVisibleRange(
  scrollLeft: number,
  width: number,
  itemStride: number,
  count: number,
  overscan: number,
): { start: number; end: number } {
  if (count <= 0 || itemStride <= 0 || width <= 0) return { start: 0, end: 0 };
  const rawStart = Math.floor(scrollLeft / itemStride) - overscan;
  const rawEnd = Math.ceil((scrollLeft + width) / itemStride) + overscan;
  const start = Math.max(0, Math.min(count, rawStart));
  const end = Math.max(start, Math.min(count, rawEnd));
  return { start, end };
}

/**
 * Compute the off-screen prefetch window adjacent to the current
 * visible range. Direction `1` looks forward (after `visible.end`);
 * `-1` looks backward (before `visible.start`). Returns a half-open
 * `[start, end)` clamped to `[0, count]`.
 *
 * Pure so it can be unit-tested without DOM or async machinery.
 */
export function computePrefetchRange(
  visible: { start: number; end: number },
  direction: number,
  ahead: number,
  count: number,
): { start: number; end: number } {
  if (count <= 0 || ahead <= 0) return { start: 0, end: 0 };
  if (direction >= 0) {
    const start = Math.max(0, Math.min(count, visible.end));
    const end = Math.max(start, Math.min(count, visible.end + ahead));
    return { start, end };
  }
  const end = Math.max(0, Math.min(count, visible.start));
  const start = Math.max(0, Math.min(count, visible.start - ahead));
  return { start, end };
}

interface PageThumbnailStripProps {
  bookId: string;
  format: "cbz" | "cbr" | "pdf";
  totalPages: number;
  currentPage: number;
  onSelect: (pageIndex: number) => void;
}

/**
 * Horizontal strip of page thumbnails for image-based formats
 * (CBZ/CBR/PDF). Thumbnails are fetched on demand through the
 * existing binary page commands at a small render width, cached as
 * blob URLs, and revoked on unmount / cache eviction.
 *
 * Virtualized: only thumbnails inside the visible window (+ overscan)
 * are actually rendered as DOM nodes, so a 1000-page book is cheap.
 */
export default function PageThumbnailStrip({
  bookId,
  format,
  totalPages,
  currentPage,
  onSelect,
}: PageThumbnailStripProps) {
  const { t } = useTranslation();
  const isPdf = format === "pdf";

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewWidth, setViewWidth] = useState(0);
  // Direction of the most recent scroll event. `1` = forward (right),
  // `-1` = backward, `0` = no scroll yet. Used by the prefetch effect
  // to bias work toward where the user is heading.
  const scrollDirRef = useRef(0);
  const lastScrollRef = useRef(0);

  // Per-book cache (shared across mount/unmount cycles of this
  // component). Reading from refs keeps the call-sites unchanged.
  const bookCache = getBookCache(bookId);
  const cacheRef = useRef(bookCache.urls);
  const inflightRef = useRef(bookCache.inflight);
  const errorRef = useRef(bookCache.errors);
  // Keep refs pointing at the active book's cache whenever bookId
  // changes (the Reader stays mounted across books).
  cacheRef.current = bookCache.urls;
  inflightRef.current = bookCache.inflight;
  errorRef.current = bookCache.errors;
  // Generation lives on the BookCache itself so that any in-flight
  // promise resolving after a book switch sees the bumped counter
  // and drops its blob URL.
  const generationRef = useRef(bookCache.generation);
  generationRef.current = bookCache.generation;
  // Trigger a re-render when a thumbnail finishes loading. We do not
  // store the URLs in React state — `cacheRef` is the source of truth
  // — but components need to repaint when fresh entries land.
  const [, forceTick] = useState(0);
  const tick = useCallback(() => forceTick((n) => n + 1), []);

  // Evict caches for any books other than the active one. Runs on
  // bookId change; the active book's cache survives strip toggling.
  useEffect(() => {
    for (const otherId of [...bookCaches.keys()]) {
      if (otherId !== bookId) evictBookCache(otherId);
    }
  }, [bookId]);

  // Track viewport width so we can compute the visible range
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setViewWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setViewWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = el.scrollLeft;
    if (next > lastScrollRef.current) scrollDirRef.current = 1;
    else if (next < lastScrollRef.current) scrollDirRef.current = -1;
    lastScrollRef.current = next;
    setScrollLeft(next);
  }, []);

  const visible = useMemo(
    () => computeVisibleRange(scrollLeft, viewWidth, ITEM_STRIDE, totalPages, OVERSCAN),
    [scrollLeft, viewWidth, totalPages],
  );

  // Load the thumbnail bytes for a single page and write the resulting
  // blob URL into the cache. No-op if the entry is already present or
  // in-flight. Bumps a tick so the visible range re-renders the new tile.
  //
  // `markError` controls whether a failure is recorded in `errorRef`.
  // Visible (foreground) loads pass `true` so the tile surfaces a retry
  // affordance. Speculative prefetch loads pass `false` so transient
  // background failures do not poison the normal on-demand load path
  // when the user later scrolls to that page.
  const loadThumb = useCallback(
    async (index: number, options?: { markError?: boolean }) => {
      const markError = options?.markError ?? true;
      // Pin the cache for this fetch to the BookCache identity at
      // call time. If the book later switches (cache eviction bumps
      // generation), the resolution branch drops its result rather
      // than poisoning a new book's state.
      const cache = bookCache;
      if (cache.urls.has(index)) return;
      if (cache.inflight.has(index)) return;
      cache.inflight.add(index);
      cache.errors.delete(index);
      const startingGen = cache.generation;
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const renderWidth = Math.round(THUMB_WIDTH * dpr);
      const command = isPdf ? "get_pdf_page_bytes" : "get_comic_page_bytes";
      const params: Record<string, unknown> = { bookId, pageIndex: index };
      if (isPdf) params.width = renderWidth;
      else params.targetWidth = renderWidth;
      try {
        const payload = await invoke<ArrayBuffer>(command, params);
        if (cache.generation !== startingGen) return;
        const { url } = blobUrlFromBytes(payload);
        const existing = cache.urls.get(index);
        if (existing && existing !== url) {
          URL.revokeObjectURL(url);
          return;
        }
        cache.urls.set(index, url);
        while (cache.urls.size > CACHE_LIMIT) {
          const oldest = cache.urls.keys().next().value;
          if (oldest === undefined || oldest === index) break;
          const oldUrl = cache.urls.get(oldest);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          cache.urls.delete(oldest);
        }
        tick();
      } catch {
        if (markError && cache.generation === startingGen) {
          cache.errors.add(index);
          tick();
        }
      } finally {
        cache.inflight.delete(index);
      }
    },
    [bookId, isPdf, bookCache, tick],
  );

  // Retry an errored tile by clearing its error mark and re-issuing
  // the load. Used by tile click handlers when the page is in the
  // error state.
  const retryThumb = useCallback(
    (index: number) => {
      errorRef.current.delete(index);
      tick();
      void loadThumb(index);
    },
    [loadThumb, tick],
  );

  // Fire loads for every visible thumb whenever the window moves.
  // Ordering matters: pdfium / the archive readers serve invokes
  // roughly in submission order, so we sort missing tiles by their
  // distance from `currentPage` first. The result is that the active
  // page and its immediate neighbours decode before far-away tiles
  // the user is unlikely to look at right away.
  useEffect(() => {
    const missing: number[] = [];
    for (let i = visible.start; i < visible.end; i++) {
      if (!cacheRef.current.has(i) && !errorRef.current.has(i)) missing.push(i);
    }
    missing.sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage));
    for (const i of missing) void loadThumb(i);
  }, [visible.start, visible.end, loadThumb, currentPage]);

  // Prefetch tiles just past the visible window in the current scroll
  // direction. Errored tiles are skipped — the user retries explicitly.
  // Prefetch failures are swallowed (markError: false) so a transient
  // background error does not surface as a user-visible retry tile
  // before they ever scrolled there. Ordering follows the same
  // distance-from-current rule as the visible-range loader.
  useEffect(() => {
    const range = computePrefetchRange(
      visible,
      scrollDirRef.current,
      PREFETCH_AHEAD,
      totalPages,
    );
    const missing: number[] = [];
    for (let i = range.start; i < range.end; i++) {
      if (!cacheRef.current.has(i) && !errorRef.current.has(i)) missing.push(i);
    }
    missing.sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage));
    for (const i of missing) void loadThumb(i, { markError: false });
  }, [visible.start, visible.end, loadThumb, totalPages, currentPage]);

  // When the current page changes, scroll the active thumb into view.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const target = currentPage * ITEM_STRIDE;
    if (target < el.scrollLeft || target + ITEM_STRIDE > el.scrollLeft + el.clientWidth) {
      el.scrollTo({
        left: target - el.clientWidth / 2 + ITEM_STRIDE / 2,
        behavior: "smooth",
      });
    }
  }, [currentPage]);

  const totalWidth = totalPages * ITEM_STRIDE - (totalPages > 0 ? GAP : 0);

  const tiles = [];
  for (let i = visible.start; i < visible.end; i++) {
    const url = cacheRef.current.get(i);
    const errored = errorRef.current.has(i);
    const hasImage = Boolean(url);
    const isActive = i === currentPage;
    const label = errored
      ? t("reader.thumbnailRetry", { number: i + 1 })
      : t("reader.thumbnailGoTo", { number: i + 1 });

    // Chrome (border / bg / shadow) only paints when the tile has
    // something to frame: a loaded image, or the active page. Empty
    // loading and errored tiles render as transparent slots that
    // float their glyph on the surface — keeps the strip quiet while
    // many pages decode in parallel.
    let chrome: string;
    if (hasImage && isActive) {
      chrome =
        "border border-accent ring-1 ring-accent bg-accent-light/60 dark:bg-accent-light/30 shadow-[0_4px_14px_-6px_rgba(44,34,24,0.35)] scale-[1.04] z-10";
    } else if (hasImage) {
      chrome =
        "border border-warm-border hover:border-accent/60 hover:-translate-y-px hover:shadow-[0_3px_10px_-6px_rgba(44,34,24,0.25)] bg-warm-subtle";
    } else if (isActive) {
      // Active but image not yet decoded — outline only, no fill, so
      // the active marker remains visible while the page renders.
      chrome = "border border-accent/60 z-10";
    } else {
      // Loading or errored, inactive — no chrome at all.
      chrome = "border border-transparent";
    }

    tiles.push(
      <button
        key={i}
        type="button"
        onClick={() => (errored ? retryThumb(i) : onSelect(i))}
        className={`absolute top-0 flex flex-col items-center justify-end p-0.5 rounded-sm will-change-transform transition-[transform,border-color,background-color,box-shadow,opacity] duration-200 ease-out motion-reduce:transition-none ${chrome}`}
        style={{
          left: i * ITEM_STRIDE,
          width: THUMB_WIDTH,
          height: THUMB_HEIGHT,
        }}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        title={errored ? label : undefined}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="max-w-full max-h-[88%] object-contain animate-thumb-in motion-reduce:animate-none"
            draggable={false}
          />
        ) : errored ? (
          <div className="flex-1 w-full flex items-center justify-center text-red-400/80 dark:text-red-400/70 animate-fade-in motion-reduce:animate-none">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        ) : (
          <div className="flex-1 w-full flex items-center justify-center text-ink-muted/40">
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>
        )}
        <span
          className={`text-[10px] tabular-nums leading-none mt-0.5 transition-colors duration-200 ease-out motion-reduce:transition-none ${
            isActive ? "text-accent font-medium" : "text-ink-muted/70"
          }`}
        >
          {i + 1}
        </span>
      </button>,
    );
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      className="shrink-0 w-full overflow-x-auto overflow-y-hidden bg-surface border-t border-warm-border animate-slide-in-up motion-reduce:animate-none thumb-strip-mask"
      style={{ height: THUMB_HEIGHT + 12 }}
      role="listbox"
      aria-label={t("reader.thumbnailStripLabel")}
    >
      <div
        className="relative h-full"
        style={{ width: Math.max(totalWidth, 0), paddingTop: 6, paddingBottom: 6 }}
      >
        {tiles}
      </div>
    </div>
  );
}
