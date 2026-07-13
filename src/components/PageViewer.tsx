import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getSpreadPages } from "../lib/utils";
import { friendlyError } from "../lib/errors";
import { blobUrlFromBytes } from "../lib/pageWire";
import { glyphToPx, highlightBands, selectionOffsets, type Glyph } from "../lib/pdfText";
import { HIGHLIGHT_COLORS } from "./HighlightsPanel";
import { useToast } from "./Toast";

/** A resolved PDF text selection, in the page's char-offset space. */
export interface PdfSelection {
  text: string;
  startOffset: number;
  endOffset: number;
  pageIndex: number;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

// Enable with: localStorage.setItem("folio-debug-pages", "1")
// Disable with: localStorage.removeItem("folio-debug-pages")
// Takes effect immediately — no reload needed.
function dbg(...args: unknown[]) {
  if (localStorage.getItem("folio-debug-pages") === "1") {
    console.warn("[page-load]", ...args);
  }
}

interface PageViewerProps {
  bookId: string;
  format: "cbz" | "cbr" | "pdf";
  totalPages: number;
  initialPage?: number;
  onPageChange?: (pageIndex: number) => void;
  /**
   * Fires when the user jumps to a non-adjacent page via the "Go to page"
   * input — distinct from prev/next sequential navigation. The receiver is
   * expected to record the jump in navigation history so back/forward can
   * return to the source page.
   */
  onPageJump?: (targetIndex: number) => void;
  dualPage?: boolean;
  mangaMode?: boolean;
  pageAnimation?: boolean;
  /** When false, skip the window-level keydown listener (split-mode companion pane). */
  keyboardEnabled?: boolean;
  /**
   * PDF-only (F-1-4). Create a highlight from a text-layer selection.
   * Provided by ReaderPane so PDF highlights run the same IPC + toast/undo
   * path as the EPUB reader. Absent for comics.
   */
  onCreateHighlight?: (color: string, sel: PdfSelection) => Promise<unknown> | void;
  /** PDF-only. Remove the given highlight ids (selection-overlap clear). */
  onRemoveHighlights?: (ids: string[]) => Promise<void> | void;
  /** PDF-only. Bumps whenever a highlight is created/removed elsewhere so the
   *  visible page's saved-highlight bands re-fetch. */
  highlightRefreshKey?: number;
}

export default function PageViewer({
  bookId,
  format,
  totalPages,
  initialPage = 0,
  onPageChange,
  onPageJump,
  dualPage = false,
  mangaMode = false,
  pageAnimation = true,
  keyboardEnabled = true,
  onCreateHighlight,
  onRemoveHighlights,
  highlightRefreshKey = 0,
}: PageViewerProps) {
  const [pageIndex, setPageIndex] = useState(initialPage);

  // Sync with external page changes (e.g. search result navigation)
  const prevInitialPage = useRef(initialPage);
  useEffect(() => {
    if (initialPage !== prevInitialPage.current) {
      prevInitialPage.current = initialPage;
      setPageIndex(initialPage);
      onPageChange?.(initialPage);
    }
  }, [initialPage, onPageChange]);

  const [leftImageData, setLeftImageData] = useState<string | null>(null);
  const [rightImageData, setRightImageData] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // Zoom & pan state — restore persisted zoom level per book
  const zoomStorageKey = `folio-zoom-${bookId}`;
  const zoomPersistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [zoom, setZoomState] = useState(() => {
    const stored = localStorage.getItem(zoomStorageKey);
    if (stored) {
      const parsed = parseFloat(stored);
      if (!isNaN(parsed) && parsed >= MIN_ZOOM && parsed <= MAX_ZOOM) return parsed;
    }
    return 1;
  });
  const [zoomRestored, setZoomRestored] = useState(() => {
    const stored = localStorage.getItem(zoomStorageKey);
    if (stored) {
      const parsed = parseFloat(stored);
      return !isNaN(parsed) && parsed >= MIN_ZOOM && parsed <= MAX_ZOOM && parsed !== 1;
    }
    return false;
  });
  // Auto-hide zoom-restored indicator after 2s
  useEffect(() => {
    if (!zoomRestored) return;
    const t = setTimeout(() => setZoomRestored(false), 2000);
    return () => clearTimeout(t);
  }, [zoomRestored]);
  const setZoom = useCallback((value: number | ((prev: number) => number)) => {
    setZoomState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      clearTimeout(zoomPersistTimer.current);
      zoomPersistTimer.current = setTimeout(() => {
        localStorage.setItem(zoomStorageKey, String(next));
      }, 500);
      return next;
    });
    setZoomRestored(false);
  }, [zoomStorageKey]);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const spreadRef = useRef<HTMLDivElement>(null);
  // Refs to the rendered page images — the PDF text layer measures each
  // image's object-contain rendered box to position glyph spans/bands.
  const leftImgRef = useRef<HTMLImageElement>(null);
  const rightImgRef = useRef<HTMLImageElement>(null);
  const directionRef = useRef<"left" | "right">("right");
  const isInitialLoad = useRef(true);
  const animationRef = useRef<Animation | null>(null);
  const isAnimating = useRef(false);
  // Tracks the last page index that successfully animated in. Used to
  // suppress redundant slide-in animations that fire when the
  // load-spread effect re-runs for reasons that are not a real page
  // turn — for example, a `renderWidth` quantization flip caused by a
  // sibling component (the thumbnail strip) mounting and reflowing
  // the layout, which changes the cache key and forces a re-fetch.
  const lastAnimatedPageRef = useRef<number | null>(null);

  const { t } = useTranslation();
  const isPdf = format === "pdf";
  const spread = dualPage ? getSpreadPages(pageIndex, totalPages) : { left: pageIndex, right: null };

  // Apply transform directly to the DOM (no React re-render).
  // Use physical resize (width/height %) so the browser resamples images at full resolution
  // instead of CSS scale() which blurs by upscaling the rasterized paint buffer.
  const applyTransform = useCallback((z: number, p: { x: number; y: number }) => {
    if (!spreadRef.current) return;
    spreadRef.current.style.width = `${z * 100}%`;
    spreadRef.current.style.height = `${z * 100}%`;
    spreadRef.current.style.transform = `translate(calc(-50% + ${p.x}px), calc(-50% + ${p.y}px))`;
  }, []);

  // Animate new page sliding into view using Web Animations API.
  // Runs on spreadRef directly — the API applies the animation in a separate layer
  // that overrides inline styles during playback, then reverts when done.
  // No conflict with applyTransform's inline styles.
  const slideIn = useCallback(() => {
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      return;
    }
    if (!pageAnimation || !spreadRef.current) return;
    // Cancel any in-progress animation
    animationRef.current?.cancel();
    // Offset is half the container width — enough to start fully off-page
    const containerW = containerRef.current?.clientWidth ?? 800;
    const offset = directionRef.current === "right" ? containerW / 2 : -containerW / 2;
    isAnimating.current = true;
    animationRef.current = spreadRef.current.animate([
      { transform: `translate(calc(-50% + ${offset}px), calc(-50%))`, opacity: 0.3 },
      { transform: `translate(calc(-50%), calc(-50%))`, opacity: 1 },
    ], { duration: 300, easing: "ease-out" });
    animationRef.current.onfinish = () => { isAnimating.current = false; };
    animationRef.current.oncancel = () => { isAnimating.current = false; };
  }, [pageAnimation]);

  const slideInRef = useRef(slideIn);
  useEffect(() => { slideInRef.current = slideIn; }, [slideIn]);

  // Quantize zoom to nearest 0.25 so we don't re-render on every tiny change
  const renderZoom = Math.ceil(zoom * 4) / 4;

  // Fetches a single page from the backend over the binary wire format
  // and returns a blob URL ready to assign to `<img src>`. The caller
  // owns the URL and must `URL.revokeObjectURL` it when no longer in use
  // (handled here by the cache eviction + unmount paths below).
  const loadPage = useCallback(
    async (index: number, renderWidth: number): Promise<string> => {
      const command = isPdf ? "get_pdf_page_bytes" : "get_comic_page_bytes";
      // Tauri auto-converts snake_case Rust params to camelCase JS keys.
      // `get_pdf_page_bytes` exposes `width`; `get_comic_page_bytes`
      // exposes `targetWidth`. Both accept zero/undefined as "default".
      const params: Record<string, unknown> = { bookId, pageIndex: index };
      if (renderWidth > 0) {
        if (isPdf) params.width = renderWidth;
        else params.targetWidth = renderWidth;
      }
      dbg(`invoke ${command} page=${index} width=${renderWidth}`);
      const t0 = performance.now();
      const payload = await invoke<ArrayBuffer>(command, params);
      const { url, mime } = blobUrlFromBytes(payload);
      dbg(
        `invoke ${command} page=${index} done in ${(performance.now() - t0).toFixed(0)}ms ` +
          `size=${(payload.byteLength / 1024).toFixed(0)}KB mime=${mime}`
      );
      return url;
    },
    [bookId, isPdf]
  );

  // Render-target width — quantized to the nearest 100 px so that small
  // window-size jitter doesn't invalidate the cache or trigger redundant
  // backend renders. Multiplied by DPR for Retina sharpness and by
  // `max(renderZoom, 1)` so zoomed-in views request a higher-resolution
  // source instead of upscaling a blurry low-res blob.
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setContainerWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const renderWidth = (() => {
    // Default to a reasonable fallback before the container measures so
    // the very first page request still gets a sane width.
    const base = containerWidth > 0 ? containerWidth : 1600;
    const perPage = dualPage ? base / 2 : base;
    const raw = perPage * Math.max(renderZoom, 1) * dpr;
    // Quantize and clamp. The backend clamps to 9600 too — match it.
    const quantized = Math.round(raw / 100) * 100;
    return Math.min(9600, Math.max(400, quantized));
  })();

  // Blob URL cache keyed by `{pageIndex}:{renderWidth}`. URLs evicted
  // here MUST be revoked or the renderer keeps the blob alive
  // indefinitely — a 4 MB page leaks once per page turn otherwise.
  const pageCacheRef = useRef<Map<string, string>>(new Map());
  const inflightRef = useRef<Map<string, Promise<string>>>(new Map());
  // Generation counter — bumps on bookId change/unmount cleanup. Each
  // in-flight `loadPage` snapshots the generation at start; when the
  // promise resolves we compare against the live counter to reject and
  // revoke stale blobs that would otherwise either leak (URL never put
  // into the cache, never revoked) or cross-contaminate the next book
  // by being inserted under a key like `0:1600` that the new book also
  // requests.
  const generationRef = useRef(0);

  const evictUrl = useCallback((key: string) => {
    const url = pageCacheRef.current.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      pageCacheRef.current.delete(key);
    }
  }, []);

  const loadPageCached = useCallback(
    async (index: number, width: number): Promise<string> => {
      const key = `${index}:${width}`;
      const cached = pageCacheRef.current.get(key);
      if (cached) {
        dbg(`frontend cache HIT page=${index}`);
        return cached;
      }
      const inflight = inflightRef.current.get(key);
      if (inflight) {
        dbg(`frontend cache PENDING page=${index}, reusing in-flight request`);
        return inflight;
      }
      dbg(`frontend cache MISS page=${index}, fetching...`);
      const myGen = generationRef.current;
      const promise = loadPage(index, width)
        .then((url) => {
          // Stale: bookId changed (or component unmounted) while the
          // backend was rendering. Revoke immediately so the blob does
          // NOT enter the cache (where the new book might pick it up
          // under the same key) and does NOT leak.
          if (myGen !== generationRef.current) {
            URL.revokeObjectURL(url);
            inflightRef.current.delete(key);
            throw new Error("page load aborted: book changed");
          }
          // If another request for the same key beat us to it (rare —
          // we de-dupe via inflightRef above — but possible across
          // re-renders), drop the duplicate blob to avoid a leak.
          const existing = pageCacheRef.current.get(key);
          if (existing && existing !== url) {
            URL.revokeObjectURL(url);
            inflightRef.current.delete(key);
            return existing;
          }
          pageCacheRef.current.set(key, url);
          inflightRef.current.delete(key);
          while (pageCacheRef.current.size > 10) {
            const oldest = pageCacheRef.current.keys().next().value;
            if (oldest === undefined) break;
            evictUrl(oldest);
          }
          return url;
        })
        .catch((err) => {
          inflightRef.current.delete(key);
          throw err;
        });
      inflightRef.current.set(key, promise);
      return promise;
    },
    [loadPage, evictUrl]
  );

  // Revoke every cached blob URL when the viewer unmounts or the book
  // switches — otherwise the renderer keeps every page we ever loaded
  // alive in memory.
  useEffect(() => {
    const cacheRef = pageCacheRef;
    return () => {
      // Bump first so any in-flight promises that resolve AFTER this
      // cleanup runs see a stale generation and revoke their blobs
      // instead of leaking or contaminating the next book.
      generationRef.current += 1;
      for (const url of cacheRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      cacheRef.current.clear();
      inflightRef.current.clear();
    };
  }, [bookId]);

  // Load spread (one or two pages in parallel) with timeout
  useEffect(() => {
    let cancelled = false;
    let rafId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(null);

    // Clear stale in-flight entries for pages we no longer need.
    // This prevents abandoned renders from blocking the pdfium queue.
    const keep = new Set<string>();
    keep.add(`${spread.left}:${renderWidth}`);
    if (spread.right !== null) keep.add(`${spread.right}:${renderWidth}`);
    for (const key of inflightRef.current.keys()) {
      if (!keep.has(key)) {
        dbg(`clearing stale inflight: ${key}`);
        inflightRef.current.delete(key);
      }
    }

    // Show "taking longer than expected" after 8s while still waiting
    let slowTimerId: ReturnType<typeof setTimeout> | undefined;

    const loadSpread = async () => {
      dbg(`loadSpread: left=${spread.left} right=${spread.right} retry=${retryCount}`);
      const t0 = performance.now();
      slowTimerId = setTimeout(() => {
        if (!cancelled) setError(t("reader.pageLoadSlow"));
      }, 8000);
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("timeout")), 30000);
        });
        const promises: Promise<string>[] = [loadPageCached(spread.left, renderWidth)];
        if (spread.right !== null) {
          promises.push(loadPageCached(spread.right, renderWidth));
        }
        const results = await Promise.race([Promise.all(promises), timeout]);
        clearTimeout(timeoutId);
        clearTimeout(slowTimerId);
        dbg(`loadSpread complete in ${(performance.now() - t0).toFixed(0)}ms`);
        if (cancelled) return;
        setError(null);
        setLeftImageData(results[0]);
        setRightImageData(results.length > 1 ? results[1] : null);
        // Slide in after new images are set — but only when the
        // page actually changed. A second loadSpread fire for the
        // same page (e.g. cache key churn after a sibling reflow)
        // would otherwise replay the slide animation on a page that
        // is already on screen.
        if (lastAnimatedPageRef.current !== spread.left) {
          lastAnimatedPageRef.current = spread.left;
          rafId = requestAnimationFrame(() => {
            if (!cancelled) slideInRef.current();
          });
        }
      } catch (err) {
        clearTimeout(timeoutId);
        clearTimeout(slowTimerId);
        dbg(`loadSpread FAILED after ${(performance.now() - t0).toFixed(0)}ms:`, err);
        if (!cancelled) {
          const msg = err instanceof Error && err.message === "timeout"
            ? t("reader.pageLoadTimeout")
            : friendlyError(err, t);
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadSpread();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      clearTimeout(slowTimerId);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  }, [spread.left, spread.right, loadPageCached, renderWidth, retryCount]);

  // Preload adjacent spreads in the background after current spread renders.
  // Debounced by 500ms to prevent queue buildup during fast navigation.
  useEffect(() => {
    if (loading) return;
    const timerId = setTimeout(() => {
      const toPreload: number[] = [];
      if (dualPage) {
        // Previous spread
        if (spread.left > 0) {
          const prevLeft = spread.left <= 2 ? 0 : spread.left - 2;
          toPreload.push(prevLeft);
          const { right } = getSpreadPages(prevLeft, totalPages);
          if (right !== null) toPreload.push(right);
        }
        // Next spread
        const nextLeft = spread.right !== null ? spread.right + 1 : spread.left + 1;
        if (nextLeft < totalPages) {
          toPreload.push(nextLeft);
          const { right } = getSpreadPages(nextLeft, totalPages);
          if (right !== null) toPreload.push(right);
        }
      } else {
        if (spread.left > 0) toPreload.push(spread.left - 1);
        if (spread.left < totalPages - 1) toPreload.push(spread.left + 1);
      }
      // Fire-and-forget — don't block on preloads
      for (const idx of toPreload) {
        dbg(`preload page=${idx}`);
        loadPageCached(idx, renderWidth);
      }
    }, 500);
    return () => clearTimeout(timerId);
  }, [loading, spread.left, spread.right, dualPage, totalPages, loadPageCached, renderWidth]);

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= totalPages) return;
      setPageIndex(index);
      onPageChange?.(index);
      // Reset zoom/pan on page change
      setZoom(1);
      panRef.current = { x: 0, y: 0 };
      applyTransform(1, panRef.current);
    },
    [totalPages, onPageChange, applyTransform, setZoom]
  );

  // Navigate by spread: advance to next/prev spread's left page
  const prevSpread = useCallback(() => {
    if (isAnimating.current) return;
    directionRef.current = "left";
    if (dualPage) {
      if (spread.left <= 0) return;
      const prevLeft = spread.left <= 2 ? 0 : spread.left - 2;
      goTo(prevLeft);
    } else {
      goTo(pageIndex - 1);
    }
  }, [dualPage, spread.left, pageIndex, goTo]);

  const nextSpread = useCallback(() => {
    if (isAnimating.current) return;
    directionRef.current = "right";
    if (dualPage) {
      const nextLeft = spread.right !== null ? spread.right + 1 : spread.left + 1;
      if (nextLeft >= totalPages) return;
      goTo(nextLeft);
    } else {
      goTo(pageIndex + 1);
    }
  }, [dualPage, spread, pageIndex, totalPages, goTo]);

  // Keep DOM transform in sync with zoom state (React doesn't manage this inline)
  useEffect(() => {
    applyTransform(zoom, panRef.current);
  }, [zoom, applyTransform]);

  const isAtStart = dualPage ? spread.left <= 0 : pageIndex <= 0;
  const isAtEnd = dualPage
    ? (spread.right !== null ? spread.right >= totalPages - 1 : spread.left >= totalPages - 1)
    : pageIndex >= totalPages - 1;

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + ZOOM_STEP) * 100) / 100));
  }, []);
  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const next = Math.max(MIN_ZOOM, Math.round((z - ZOOM_STEP) * 100) / 100);
      if (next <= 1) {
        panRef.current = { x: 0, y: 0 };
        applyTransform(next, panRef.current);
      }
      return next;
    });
  }, [applyTransform]);
  const zoomReset = useCallback(() => {
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    applyTransform(1, panRef.current);
  }, [applyTransform]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Alt+Arrow is reserved for the Reader's navigation history; don't
      // also consume it as page-prev/next.
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;

      if (e.key === "ArrowLeft") mangaMode ? nextSpread() : prevSpread();
      else if (e.key === "ArrowRight") mangaMode ? prevSpread() : nextSpread();
      else if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        zoomReset();
      }
    }
    if (!keyboardEnabled) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevSpread, nextSpread, zoomIn, zoomOut, zoomReset, mangaMode, keyboardEnabled]);

  const wheelCooldown = useRef(false);
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
        return;
      }
      if (canPan()) return;
      if (wheelCooldown.current || loading) return;
      if (Math.abs(e.deltaY) < 10) return;
      wheelCooldown.current = true;
      if (e.deltaY > 0) nextSpread();
      else prevSpread();
      setTimeout(() => { wheelCooldown.current = false; }, 300);
    },
    [nextSpread, prevSpread, loading, zoomIn, zoomOut, zoom]
  );

  // Measure content vs container to determine pan overflow
  const getOverflow = useCallback(() => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const containerW = containerRef.current.clientWidth;
    const containerH = containerRef.current.clientHeight;
    // Spread is physically zoom-sized (width/height %), no CSS scale
    const contentW = containerW * zoom;
    const contentH = containerH * zoom;
    return {
      x: Math.max(0, contentW - containerW),
      y: Math.max(0, contentH - containerH),
    };
  }, [zoom]);

  const canPan = useCallback(() => {
    const overflow = getOverflow();
    return overflow.x > 1 || overflow.y > 1;
  }, [getOverflow]);

  // Clamp pan so content can't be dragged beyond its edges
  const clampPan = useCallback((p: { x: number; y: number }): { x: number; y: number } => {
    const overflow = getOverflow();
    const maxPanX = overflow.x / 2;
    const maxPanY = overflow.y / 2;
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, p.x)),
      y: Math.max(-maxPanY, Math.min(maxPanY, p.y)),
    };
  }, [getOverflow]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!canPan()) return;
      e.preventDefault();
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY };
      panOffset.current = { ...panRef.current };
    },
    [canPan]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      const raw = {
        x: panOffset.current.x + dx,
        y: panOffset.current.y + dy,
      };
      panRef.current = clampPan(raw);
      applyTransform(zoom, panRef.current);
    },
    [zoom, applyTransform, clampPan]
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const [editingPage, setEditingPage] = useState(false);
  const [pageInput, setPageInput] = useState("");
  const pageInputRef = useRef<HTMLInputElement>(null);

  const handlePageLabelClick = useCallback(() => {
    setPageInput(String(spread.left + 1));
    setEditingPage(true);
  }, [spread.left]);

  const handlePageInputSubmit = useCallback(() => {
    const num = parseInt(pageInput, 10);
    if (!isNaN(num) && num >= 1 && num <= totalPages) {
      directionRef.current = "right";
      const target = num - 1;
      // Fire the jump notification *before* goTo so the listener can read the
      // pre-jump page index for history's source entry.
      if (target !== pageIndex) onPageJump?.(target);
      goTo(target);
    }
    setEditingPage(false);
  }, [pageInput, totalPages, pageIndex, goTo, onPageJump]);

  useEffect(() => {
    if (editingPage && pageInputRef.current) {
      pageInputRef.current.select();
    }
  }, [editingPage]);

  const pageLabel = dualPage && spread.right !== null
    ? `${t("reader.pages")} ${spread.left + 1}–${spread.right + 1} / ${totalPages}`
    : `${t("reader.page")} ${spread.left + 1} / ${totalPages}`;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-paper">
      {/* Page image area */}
      <div
        ref={containerRef}
        className={`flex-1 relative overflow-hidden ${canPan() ? "cursor-grab active:cursor-grabbing" : ""}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Always render spread so spreadRef stays mounted for animations */}
        <div
          ref={spreadRef}
          className={`absolute top-1/2 left-1/2 flex items-center justify-center gap-1 will-change-transform ${mangaMode && dualPage ? "flex-row-reverse" : "flex-row"}`}
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, transform: `translate(calc(-50% + ${panRef.current.x}px), calc(-50% + ${panRef.current.y}px))` }}
        >
          {/* PDF pages wrap the image so the selectable text layer (F-1-4)
              can overlay the object-contain rendered box. Comics keep the
              bare-image markup unchanged — no text layer, no layout shift. */}
          {leftImageData && (
            isPdf ? (
              <div className="relative flex-1 min-w-0 h-full flex items-center justify-center">
                <img
                  ref={leftImgRef}
                  src={leftImageData}
                  alt={`Page ${spread.left + 1} of ${totalPages}`}
                  className="max-h-full max-w-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
                  draggable={false}
                  onError={() =>
                    setError(t("reader.failedToLoadPage", { error: t("reader.imageDecodeError") }))
                  }
                />
                <PdfTextLayer
                  bookId={bookId}
                  pageIndex={spread.left}
                  imgRef={leftImgRef}
                  refreshKey={highlightRefreshKey}
                  onCreateHighlight={onCreateHighlight}
                  onRemoveHighlights={onRemoveHighlights}
                />
              </div>
            ) : (
              <img
                src={leftImageData}
                alt={`Page ${spread.left + 1} of ${totalPages}`}
                className="max-h-full max-w-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
                style={dualPage && rightImageData ? { maxWidth: "50%" } : undefined}
                draggable={false}
                onError={() =>
                  setError(t("reader.failedToLoadPage", { error: t("reader.imageDecodeError") }))
                }
              />
            )
          )}
          {rightImageData && spread.right !== null && (
            isPdf ? (
              <div className="relative flex-1 min-w-0 h-full flex items-center justify-center">
                <img
                  ref={rightImgRef}
                  src={rightImageData}
                  alt={`Page ${(spread.right ?? 0) + 1} of ${totalPages}`}
                  className="max-h-full max-w-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
                  draggable={false}
                  onError={() =>
                    setError(t("reader.failedToLoadPage", { error: t("reader.imageDecodeError") }))
                  }
                />
                <PdfTextLayer
                  bookId={bookId}
                  pageIndex={spread.right}
                  imgRef={rightImgRef}
                  refreshKey={highlightRefreshKey}
                  onCreateHighlight={onCreateHighlight}
                  onRemoveHighlights={onRemoveHighlights}
                />
              </div>
            ) : (
              <img
                src={rightImageData}
                alt={`Page ${(spread.right ?? 0) + 1} of ${totalPages}`}
                className="max-h-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
                style={{ maxWidth: "50%" }}
                draggable={false}
                onError={() =>
                  setError(t("reader.failedToLoadPage", { error: t("reader.imageDecodeError") }))
                }
              />
            )
          )}
        </div>
        {/* Overlay: loading spinner or error on top of previous/current page */}
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-paper/80">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              <span className="text-sm text-ink-muted">{t("reader.loadingPage")}</span>
            </div>
            {error && (
              <span className="text-xs text-ink-muted/70 animate-fade-in">{error}</span>
            )}
          </div>
        )}
        {!loading && error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-paper/80">
            <span className="text-sm text-red-500 text-center max-w-sm">{error}</span>
            <button
              onClick={() => {
                // Evict from cache and in-flight so retry fetches fresh.
                // Must go through evictUrl so the blob URL is revoked —
                // a raw cache delete would leak the successfully-loaded
                // page (e.g. left page in a dual-page spread when right
                // failed).
                const key = `${spread.left}:${renderWidth}`;
                evictUrl(key);
                inflightRef.current.delete(key);
                if (spread.right !== null) {
                  const rkey = `${spread.right}:${renderWidth}`;
                  evictUrl(rkey);
                  inflightRef.current.delete(rkey);
                }
                setRetryCount((c) => c + 1);
              }}
              className="px-4 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
            >
              {t("reader.retryLoadPage")}
            </button>
          </div>
        )}
      </div>

      {/* Screen reader announcement for page changes */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {!loading && t("reader.pageOf", { current: pageIndex + 1, total: totalPages })}
      </div>

      {/* Navigation bar */}
      <div className="shrink-0 border-t border-warm-border bg-surface px-5 py-3 flex items-center gap-3">
        <button
          onClick={prevSpread}
          disabled={isAtStart}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous page"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t("common.previous")}
        </button>

        {editingPage ? (
          <form
            className="flex-1 flex items-center justify-center gap-1.5"
            onSubmit={(e) => { e.preventDefault(); handlePageInputSubmit(); }}
          >
            <input
              ref={pageInputRef}
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={() => setEditingPage(false)}
              onKeyDown={(e) => { if (e.key === "Escape") setEditingPage(false); }}
              className="w-14 text-center text-xs tabular-nums bg-warm-subtle text-ink border border-warm-border rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
              aria-label={t("reader.goToPage")}
            />
            <span className="text-xs text-ink-muted tabular-nums">/ {totalPages}</span>
          </form>
        ) : (
          <button
            type="button"
            onClick={handlePageLabelClick}
            className="flex-1 text-center text-xs text-ink-muted tabular-nums hover:text-ink transition-colors cursor-pointer"
            title={t("reader.goToPage")}
          >
            {pageLabel}
          </button>
        )}

        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 flex items-center justify-center text-xs text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors disabled:opacity-30"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={zoomReset}
            className={`px-2 h-7 text-[11px] tabular-nums rounded-lg transition-colors ${zoom !== 1 ? "text-accent bg-accent-light hover:bg-accent-light/80 font-medium" : "text-ink-muted bg-warm-subtle"} ${zoomRestored ? "animate-fade-in ring-1 ring-accent" : ""}`}
            title="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 flex items-center justify-center text-xs text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors disabled:opacity-30"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>

        <button
          onClick={nextSpread}
          disabled={isAtEnd}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next page"
        >
          {t("common.next")}
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

interface SavedHighlight {
  id: string;
  startOffset: number;
  endOffset: number;
  color: string;
}

interface PdfTextLayerProps {
  bookId: string;
  pageIndex: number;
  imgRef: RefObject<HTMLImageElement | null>;
  refreshKey: number;
  onCreateHighlight?: (color: string, sel: PdfSelection) => Promise<unknown> | void;
  onRemoveHighlights?: (ids: string[]) => Promise<void> | void;
}

/**
 * Transparent, selectable text layer over one rendered PDF page image
 * (F-1-4, desktop reader). Fetches the page's glyph rects + full text +
 * saved highlights, then overlays:
 *   - colored highlight bands (below, non-interactive), and
 *   - one transparent `<span>` per glyph carrying its real character so the
 *     browser's native selection + Cmd/Ctrl+C copies real text.
 * On selection it surfaces a copy/highlight popup wired to ReaderPane's
 * handlers. Glyph `off` values are Unicode-scalar (Rust `char`) offsets into
 * the page text, so the text is indexed via `Array.from` (code points), never
 * `pageText[off]` — see `get_pdf_page_text`'s doc comment on the backend.
 */
function PdfTextLayer({
  bookId,
  pageIndex,
  imgRef,
  refreshKey,
  onCreateHighlight,
  onRemoveHighlights,
}: PdfTextLayerProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const layerRef = useRef<HTMLDivElement>(null);
  const [glyphs, setGlyphs] = useState<Glyph[]>([]);
  const [chars, setChars] = useState<string[]>([]);
  const [saved, setSaved] = useState<SavedHighlight[]>([]);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [popup, setPopup] = useState<
    { x: number; y: number; sel: PdfSelection; overlapIds: string[] } | null
  >(null);

  // Glyph rects + page text — refetched per page (backend memory-cached).
  useEffect(() => {
    let cancelled = false;
    setPopup(null);
    (async () => {
      try {
        const [g, text] = await Promise.all([
          invoke<Glyph[]>("get_pdf_page_glyphs", { bookId, pageIndex }),
          invoke<string>("get_pdf_page_text", { bookId, pageIndex }),
        ]);
        if (cancelled) return;
        setGlyphs(g);
        setChars(Array.from(text));
      } catch {
        if (!cancelled) {
          setGlyphs([]);
          setChars([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId, pageIndex]);

  // Saved highlights — also refetched when a create/remove elsewhere bumps
  // `refreshKey` so bands stay in sync after mutations (including undo).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hls = await invoke<SavedHighlight[]>("get_chapter_highlights", {
          bookId,
          chapterIndex: pageIndex,
        });
        if (!cancelled) setSaved(hls);
      } catch {
        if (!cancelled) setSaved([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId, pageIndex, refreshKey]);

  // Measure the image's object-contain rendered box (the letterboxed content
  // rect, not the element box) so glyph rects map onto the visible pixels.
  const measure = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const cw = img.clientWidth;
    const ch = img.clientHeight;
    if (!nw || !nh || !cw || !ch) {
      setBox(null);
      return;
    }
    const scale = Math.min(cw / nw, ch / nh);
    const width = nw * scale;
    const height = nh * scale;
    setBox({
      left: img.offsetLeft + (cw - width) / 2,
      top: img.offsetTop + (ch - height) / 2,
      width,
      height,
    });
  }, [imgRef]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(img);
    img.addEventListener("load", measure);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      img.removeEventListener("load", measure);
      window.removeEventListener("resize", measure);
    };
  }, [imgRef, measure]);

  // Re-measure once new-page glyphs arrive (the image src has changed and its
  // natural dimensions may only now be available).
  useEffect(() => {
    measure();
  }, [glyphs, measure]);

  // Selection → popup. A document-level mouseup lets a drag that ends outside
  // the layer still resolve; each layer only claims selections that BEGAN
  // inside it (anchorNode containment) so a two-page spread never produces two
  // popups and selection never spans the two pages.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const glyphByOff = new Map(glyphs.map((g) => [g.off, g]));

    function handleMouseUp() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.anchorNode) return;
      if (!layer || !layer.contains(sel.anchorNode)) return;
      const picked: Glyph[] = [];
      layer.querySelectorAll<HTMLElement>("[data-off]").forEach((span) => {
        if (sel.containsNode(span, true)) {
          const g = glyphByOff.get(Number(span.dataset.off));
          if (g) picked.push(g);
        }
      });
      const offs = selectionOffsets(picked);
      if (!offs) return;
      const text = chars.slice(offs.startOffset, offs.endOffset).join("");
      if (!text) return;
      const wrap = layer.parentElement?.getBoundingClientRect();
      if (!wrap) return;
      const rangeRect = sel.getRangeAt(0).getBoundingClientRect();
      const overlapIds = saved
        .filter((h) => h.startOffset < offs.endOffset && h.endOffset > offs.startOffset)
        .map((h) => h.id);
      setPopup({
        x: rangeRect.left + rangeRect.width / 2 - wrap.left,
        y: rangeRect.top - wrap.top,
        sel: { text, startOffset: offs.startOffset, endOffset: offs.endOffset, pageIndex },
        overlapIds,
      });
    }

    function handleMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-pdf-selection-popup]")) setPopup(null);
    }

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [glyphs, chars, saved, pageIndex]);

  const dismiss = useCallback(() => {
    setPopup(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleCopy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        addToast(t("reader.copied"), "success");
      } catch {
        addToast(t("reader.copyFailed"), "error");
      }
      dismiss();
    },
    [addToast, t, dismiss],
  );

  const handleHighlight = useCallback(
    async (color: string) => {
      if (!popup) return;
      await onCreateHighlight?.(color, popup.sel);
      dismiss();
    },
    [popup, onCreateHighlight, dismiss],
  );

  const handleClear = useCallback(async () => {
    if (!popup || popup.overlapIds.length === 0) return;
    await onRemoveHighlights?.(popup.overlapIds);
    dismiss();
  }, [popup, onRemoveHighlights, dismiss]);

  if (!box) return null;

  const showBelow = popup !== null && popup.y < 44;

  return (
    <>
      <div
        ref={layerRef}
        className="absolute select-text"
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      >
        {/* Saved-highlight bands — below the spans, non-interactive so
            selection still hits the text layer. */}
        {saved.flatMap((h) =>
          highlightBands(glyphs, h.startOffset, h.endOffset, box.width, box.height).map((b, i) => (
            <div
              key={`${h.id}-${i}`}
              className="absolute pointer-events-none rounded-[1px]"
              style={{
                left: b.left,
                top: b.top,
                width: b.width,
                height: b.height,
                backgroundColor: `${h.color}66`,
              }}
            />
          )),
        )}
        {/* Transparent selectable glyph spans (every glyph, so native copy
            keeps spaces/punctuation in reading order). */}
        {glyphs.map((g) => {
          const r = glyphToPx(g, box.width, box.height);
          return (
            <span
              key={g.off}
              data-off={g.off}
              className="absolute overflow-hidden"
              style={{
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
                color: "transparent",
                cursor: "text",
                lineHeight: 1,
                whiteSpace: "pre",
                fontSize: r.height || 1,
              }}
            >
              {chars[g.off] ?? ""}
            </span>
          );
        })}
      </div>

      {popup && (
        <div
          data-pdf-selection-popup
          className="absolute z-30 flex items-center gap-1 px-2 py-1.5 bg-ink/90 backdrop-blur-sm rounded-lg shadow-lg"
          style={{
            left: `${popup.x}px`,
            top: `${popup.y}px`,
            transform: showBelow ? "translate(-50%, 8px)" : "translate(-50%, calc(-100% - 8px))",
          }}
        >
          {popup.sel.text.length >= 3 &&
            HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.value}
                onClick={() => handleHighlight(c.value)}
                className="w-5 h-5 rounded-full hover:scale-125 transition-transform"
                style={{ backgroundColor: c.value }}
                aria-label={t("reader.highlightColor", { color: c.name })}
              />
            ))}
          {popup.overlapIds.length > 0 && (
            <button
              onClick={handleClear}
              className="w-5 h-5 rounded-full hover:scale-125 transition-transform border border-white/40 flex items-center justify-center"
              style={{ background: "repeating-conic-gradient(#ccc 0% 25%, transparent 0% 50%) 50% / 6px 6px" }}
              aria-label={t("reader.clearHighlight")}
              title={t("reader.clearHighlight")}
            />
          )}
          <button
            onClick={() => handleCopy(popup.sel.text)}
            className="px-2 h-5 rounded text-xs font-medium text-white/90 hover:text-white hover:bg-white/10 transition-colors"
          >
            {t("reader.copySelection")}
          </button>
          <div className="w-px h-4 bg-white/20 mx-0.5" />
          <button
            onClick={dismiss}
            className="w-5 h-5 rounded-full hover:scale-125 transition-transform flex items-center justify-center text-white/60 hover:text-white"
            aria-label={t("reader.dismiss")}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}
