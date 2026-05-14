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

  // Blob URL cache keyed by page index. Revoked on eviction and on
  // unmount / book switch. Stored as a ref so async loads can write
  // back without forcing a parent re-render.
  const cacheRef = useRef<Map<number, string>>(new Map());
  const inflightRef = useRef<Set<number>>(new Set());
  // Pages whose last load attempt failed. Tiles in this set render a
  // retry affordance; clicking the tile retries the fetch instead of
  // selecting the page.
  const errorRef = useRef<Set<number>>(new Set());
  const generationRef = useRef(0);
  // Trigger a re-render when a thumbnail finishes loading. We do not
  // store the URLs in React state — `cacheRef` is the source of truth
  // — but components need to repaint when fresh entries land.
  const [, forceTick] = useState(0);
  const tick = useCallback(() => forceTick((n) => n + 1), []);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      generationRef.current += 1;
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
      inflightRef.current.clear();
      errorRef.current.clear();
    };
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

  const evict = useCallback((index: number) => {
    const url = cacheRef.current.get(index);
    if (url) {
      URL.revokeObjectURL(url);
      cacheRef.current.delete(index);
    }
  }, []);

  // Load the thumbnail bytes for a single page and write the resulting
  // blob URL into the cache. No-op if the entry is already present or
  // in-flight. Bumps a tick so the visible range re-renders the new tile.
  const loadThumb = useCallback(
    async (index: number) => {
      if (cacheRef.current.has(index)) return;
      if (inflightRef.current.has(index)) return;
      inflightRef.current.add(index);
      errorRef.current.delete(index);
      const myGen = generationRef.current;
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const renderWidth = Math.round(THUMB_WIDTH * dpr);
      const command = isPdf ? "get_pdf_page_bytes" : "get_comic_page_bytes";
      const params: Record<string, unknown> = { bookId, pageIndex: index };
      if (isPdf) params.width = renderWidth;
      else params.targetWidth = renderWidth;
      try {
        const payload = await invoke<ArrayBuffer>(command, params);
        if (myGen !== generationRef.current) return;
        const { url } = blobUrlFromBytes(payload);
        // If a duplicate concurrent load landed first, drop the late one.
        const existing = cacheRef.current.get(index);
        if (existing && existing !== url) {
          URL.revokeObjectURL(url);
          return;
        }
        cacheRef.current.set(index, url);
        while (cacheRef.current.size > CACHE_LIMIT) {
          const oldest = cacheRef.current.keys().next().value;
          if (oldest === undefined || oldest === index) break;
          evict(oldest);
        }
        tick();
      } catch {
        if (myGen === generationRef.current) {
          errorRef.current.add(index);
          tick();
        }
      } finally {
        inflightRef.current.delete(index);
      }
    },
    [bookId, isPdf, evict, tick],
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

  // Fire loads for every visible thumb whenever the window moves
  useEffect(() => {
    for (let i = visible.start; i < visible.end; i++) {
      if (!cacheRef.current.has(i) && !errorRef.current.has(i)) void loadThumb(i);
    }
  }, [visible.start, visible.end, loadThumb]);

  // Prefetch tiles just past the visible window in the current scroll
  // direction. Errored tiles are skipped — the user retries explicitly.
  useEffect(() => {
    const range = computePrefetchRange(
      visible,
      scrollDirRef.current,
      PREFETCH_AHEAD,
      totalPages,
    );
    for (let i = range.start; i < range.end; i++) {
      if (!cacheRef.current.has(i) && !errorRef.current.has(i)) void loadThumb(i);
    }
  }, [visible.start, visible.end, loadThumb, totalPages]);

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
    const isActive = i === currentPage;
    const label = errored
      ? t("reader.thumbnailRetry", { number: i + 1 })
      : t("reader.thumbnailGoTo", { number: i + 1 });
    tiles.push(
      <button
        key={i}
        type="button"
        onClick={() => (errored ? retryThumb(i) : onSelect(i))}
        className={`absolute top-0 flex flex-col items-center justify-end p-0.5 rounded-sm border transition-colors ${
          isActive
            ? "border-accent ring-1 ring-accent bg-accent-light/40"
            : errored
              ? "border-red-300 dark:border-red-900/40 bg-red-50/40 dark:bg-red-900/20 hover:border-red-400 dark:hover:border-red-700"
              : "border-warm-border hover:border-accent/60 bg-warm-subtle"
        }`}
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
            className="max-w-full max-h-[88%] object-contain"
            draggable={false}
          />
        ) : errored ? (
          <div className="flex-1 w-full flex items-center justify-center text-red-500 dark:text-red-400">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        ) : (
          <div className="flex-1 w-full flex items-center justify-center">
            <div className="w-3 h-3 border border-warm-border border-t-accent/60 rounded-full animate-spin" />
          </div>
        )}
        <span className="text-[10px] tabular-nums text-ink-muted leading-none mt-0.5">
          {i + 1}
        </span>
      </button>,
    );
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      className="shrink-0 w-full overflow-x-auto overflow-y-hidden bg-surface border-t border-warm-border"
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
