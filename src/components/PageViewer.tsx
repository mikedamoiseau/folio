import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getSpreadPages } from "../lib/utils";
import { friendlyError } from "../lib/errors";

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
  const directionRef = useRef<"left" | "right">("right");
  const isInitialLoad = useRef(true);
  const animationRef = useRef<Animation | null>(null);
  const isAnimating = useRef(false);

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

  const loadPage = useCallback(
    async (index: number, renderWidth?: number): Promise<string> => {
      const command = isPdf ? "get_pdf_page" : "get_comic_page";
      const params: Record<string, unknown> = { bookId, pageIndex: index };
      if (isPdf && renderWidth) {
        params.width = renderWidth;
      }
      dbg(`invoke ${command} page=${index}`, renderWidth ? `width=${renderWidth}` : "");
      const t0 = performance.now();
      const data = await invoke<string>(command, params);
      dbg(`invoke ${command} page=${index} done in ${(performance.now() - t0).toFixed(0)}ms size=${(data.length / 1024).toFixed(0)}KB`);
      return data;
    },
    [bookId, isPdf]
  );

  // For PDF, compute render width based on zoom + device pixel ratio for Retina sharpness
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const pdfRenderWidth = isPdf ? Math.round(1200 * Math.max(renderZoom, 1) * dpr) : undefined;

  // Page cache: resolved images keyed by "{pageIndex}:{renderWidth}"
  const pageCacheRef = useRef<Map<string, string>>(new Map());
  // In-flight promises: prevents duplicate invokes for the same page
  const inflightRef = useRef<Map<string, Promise<string>>>(new Map());

  const loadPageCached = useCallback(
    async (index: number, renderWidth?: number): Promise<string> => {
      const key = `${index}:${renderWidth ?? 0}`;
      const cached = pageCacheRef.current.get(key);
      if (cached) {
        dbg(`frontend cache HIT page=${index}`);
        return cached;
      }
      // Reuse in-flight request if one exists for this key
      const inflight = inflightRef.current.get(key);
      if (inflight) {
        dbg(`frontend cache PENDING page=${index}, reusing in-flight request`);
        return inflight;
      }
      dbg(`frontend cache MISS page=${index}, fetching...`);
      const promise = loadPage(index, renderWidth).then((data) => {
        pageCacheRef.current.set(key, data);
        inflightRef.current.delete(key);
        // Keep cache bounded (max 10 entries)
        if (pageCacheRef.current.size > 10) {
          const firstKey = pageCacheRef.current.keys().next().value;
          if (firstKey !== undefined) pageCacheRef.current.delete(firstKey);
        }
        return data;
      }).catch((err) => {
        inflightRef.current.delete(key);
        throw err;
      });
      inflightRef.current.set(key, promise);
      return promise;
    },
    [loadPage]
  );

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
    keep.add(`${spread.left}:${pdfRenderWidth ?? 0}`);
    if (spread.right !== null) keep.add(`${spread.right}:${pdfRenderWidth ?? 0}`);
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
        const promises: Promise<string>[] = [loadPageCached(spread.left, pdfRenderWidth)];
        if (spread.right !== null) {
          promises.push(loadPageCached(spread.right, pdfRenderWidth));
        }
        const results = await Promise.race([Promise.all(promises), timeout]);
        clearTimeout(timeoutId);
        clearTimeout(slowTimerId);
        dbg(`loadSpread complete in ${(performance.now() - t0).toFixed(0)}ms`);
        if (cancelled) return;
        setError(null);
        setLeftImageData(results[0]);
        setRightImageData(results.length > 1 ? results[1] : null);
        // Slide in after new images are set
        rafId = requestAnimationFrame(() => {
          if (!cancelled) slideInRef.current();
        });
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
  }, [spread.left, spread.right, loadPageCached, pdfRenderWidth, retryCount]);

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
        loadPageCached(idx, pdfRenderWidth);
      }
    }, 500);
    return () => clearTimeout(timerId);
  }, [loading, spread.left, spread.right, dualPage, totalPages, loadPageCached, pdfRenderWidth]);

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
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevSpread, nextSpread, zoomIn, zoomOut, zoomReset, mangaMode]);

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
          {leftImageData && (
            <img
              src={leftImageData}
              alt={`Page ${spread.left + 1} of ${totalPages}`}
              className="max-h-full max-w-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
              style={dualPage && rightImageData ? { maxWidth: "50%" } : undefined}
              draggable={false}
            />
          )}
          {rightImageData && (
            <img
              src={rightImageData}
              alt={`Page ${(spread.right ?? 0) + 1} of ${totalPages}`}
              className="max-h-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
              style={{ maxWidth: "50%" }}
              draggable={false}
            />
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
                // Evict from cache and in-flight so retry fetches fresh
                const key = `${spread.left}:${pdfRenderWidth ?? 0}`;
                pageCacheRef.current.delete(key);
                inflightRef.current.delete(key);
                if (spread.right !== null) {
                  const rkey = `${spread.right}:${pdfRenderWidth ?? 0}`;
                  pageCacheRef.current.delete(rkey);
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
