import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSpreadPages } from "../lib/utils";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

interface PageViewerProps {
  bookId: string;
  format: "cbz" | "cbr" | "pdf";
  totalPages: number;
  initialPage?: number;
  onPageChange?: (pageIndex: number) => void;
  dualPage?: boolean;
  mangaMode?: boolean;
}

export default function PageViewer({
  bookId,
  format,
  totalPages,
  initialPage = 0,
  onPageChange,
  dualPage = false,
  mangaMode = false,
}: PageViewerProps) {
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [leftImageData, setLeftImageData] = useState<string | null>(null);
  const [rightImageData, setRightImageData] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Zoom & pan state
  const [zoom, setZoom] = useState(1);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const spreadRef = useRef<HTMLDivElement>(null);

  const spread = dualPage ? getSpreadPages(pageIndex, totalPages) : { left: pageIndex, right: null };

  // Apply transform directly to the DOM (no React re-render)
  const applyTransform = useCallback((z: number, p: { x: number; y: number }) => {
    if (spreadRef.current) {
      spreadRef.current.style.transform = `scale(${z}) translate(${p.x / z}px, ${p.y / z}px)`;
    }
  }, []);

  const loadPage = useCallback(
    async (index: number): Promise<string> => {
      const command = format === "pdf" ? "get_pdf_page" : "get_comic_page";
      const data = await invoke<string>(command, {
        bookId,
        pageIndex: index,
      });
      return data;
    },
    [bookId, format]
  );

  // Load spread (one or two pages in parallel)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadSpread = async () => {
      try {
        const promises: Promise<string>[] = [loadPage(spread.left)];
        if (spread.right !== null) {
          promises.push(loadPage(spread.right));
        }
        const results = await Promise.all(promises);
        if (cancelled) return;
        setLeftImageData(results[0]);
        setRightImageData(results.length > 1 ? results[1] : null);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadSpread();
    return () => { cancelled = true; };
  }, [spread.left, spread.right, loadPage]);

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
    [totalPages, onPageChange, applyTransform]
  );

  // Navigate by spread: advance to next/prev spread's left page
  const prevSpread = useCallback(() => {
    if (dualPage) {
      if (spread.left <= 0) return;
      const prevLeft = spread.left <= 2 ? 0 : spread.left - 2;
      goTo(prevLeft);
    } else {
      goTo(pageIndex - 1);
    }
  }, [dualPage, spread.left, pageIndex, goTo]);

  const nextSpread = useCallback(() => {
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

  // Check if scaled content overflows the container (pan should only work when it does)
  const canPan = useCallback(() => {
    if (!spreadRef.current || !containerRef.current) return false;
    const spread = spreadRef.current.getBoundingClientRect();
    const container = containerRef.current.getBoundingClientRect();
    // Compare unscaled content size * zoom to container
    // getBoundingClientRect already includes transforms, so divide out current zoom
    const contentW = (spread.width / zoom) * zoom;
    const contentH = (spread.height / zoom) * zoom;
    return contentW > container.width || contentH > container.height;
  }, [zoom]);

  // Clamp pan so content edge can't go past the container center
  const clampPan = useCallback((p: { x: number; y: number }): { x: number; y: number } => {
    if (!spreadRef.current || !containerRef.current) return p;
    const spreadRect = spreadRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    // Content dimensions without current pan (divide out zoom for the translate portion)
    const contentW = spreadRect.width;
    const contentH = spreadRect.height;
    const maxPanX = Math.max(0, (contentW - containerRect.width) / 2 / zoom + 40 / zoom);
    const maxPanY = Math.max(0, (contentH - containerRect.height) / 2 / zoom + 40 / zoom);
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, p.x)),
      y: Math.max(-maxPanY, Math.min(maxPanY, p.y)),
    };
  }, [zoom]);

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

  const isZoomed = zoom !== 1;

  const pageLabel = dualPage && spread.right !== null
    ? `Pages ${spread.left + 1}–${spread.right + 1} / ${totalPages}`
    : `Page ${spread.left + 1} / ${totalPages}`;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-paper">
      {/* Page image area */}
      <div
        ref={containerRef}
        className={`flex-1 flex items-center justify-center overflow-hidden px-4 py-4 ${isZoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {loading ? (
          <div className="text-sm text-ink-muted">Loading page…</div>
        ) : error ? (
          <div className="text-sm text-red-500 text-center max-w-sm">
            Failed to load page: {error}
          </div>
        ) : (
          <div
            ref={spreadRef}
            className={`flex items-center justify-center gap-1 max-h-full will-change-transform ${mangaMode && dualPage ? "flex-row-reverse" : "flex-row"}`}
          >
            {leftImageData && (
              <img
                src={leftImageData}
                alt={`Page ${spread.left + 1} of ${totalPages}`}
                className="max-h-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)]"
                style={{ maxWidth: dualPage && rightImageData ? "50%" : "100%" }}
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
        )}
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
          Prev
        </button>

        <span className="flex-1 text-center text-xs text-ink-muted tabular-nums">
          {pageLabel}
        </span>

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
            className={`px-2 h-7 text-[11px] tabular-nums rounded-lg transition-colors ${isZoomed ? "text-accent bg-accent-light hover:bg-accent-light/80 font-medium" : "text-ink-muted bg-warm-subtle"}`}
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
          Next
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
