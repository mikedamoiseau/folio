import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

interface PageViewerProps {
  bookId: string;
  format: "cbz" | "cbr" | "pdf";
  totalPages: number;
  initialPage?: number;
  onPageChange?: (pageIndex: number) => void;
}

export default function PageViewer({
  bookId,
  format,
  totalPages,
  initialPage = 0,
  onPageChange,
}: PageViewerProps) {
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [imageData, setImageData] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Zoom & pan state
  const [zoom, setZoom] = useState(1);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Apply transform directly to the DOM (no React re-render)
  const applyTransform = useCallback((z: number, p: { x: number; y: number }) => {
    if (imgRef.current) {
      imgRef.current.style.transform = `scale(${z}) translate(${p.x / z}px, ${p.y / z}px)`;
    }
  }, []);

  const loadPage = useCallback(
    async (index: number) => {
      setLoading(true);
      setError(null);
      try {
        const command = format === "pdf" ? "get_pdf_page" : "get_comic_page";
        const data = await invoke<string>(command, {
          bookId,
          pageIndex: index,
        });
        setImageData(data);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [bookId, format]
  );

  useEffect(() => {
    loadPage(pageIndex);
  }, [pageIndex, loadPage]);

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= totalPages) return;
      setPageIndex(index);
      onPageChange?.(index);
      // Reset zoom/pan on page change
      setZoom(1);
      panRef.current = { x: 0, y: 0 };
    },
    [totalPages, onPageChange]
  );

  const prevPage = useCallback(() => goTo(pageIndex - 1), [pageIndex, goTo]);
  const nextPage = useCallback(() => goTo(pageIndex + 1), [pageIndex, goTo]);

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

  // Keyboard: arrows for pages, +/- for zoom
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") prevPage();
      else if (e.key === "ArrowRight") nextPage();
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
  }, [prevPage, nextPage, zoomIn, zoomOut, zoomReset]);

  // Mouse wheel: Ctrl+scroll = zoom, plain scroll = page nav
  const wheelCooldown = useRef(false);
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
        return;
      }
      // When zoomed in, let native scroll handle panning
      if (zoom > 1) return;
      if (wheelCooldown.current || loading) return;
      if (Math.abs(e.deltaY) < 10) return;
      wheelCooldown.current = true;
      if (e.deltaY > 0) nextPage();
      else prevPage();
      setTimeout(() => { wheelCooldown.current = false; }, 300);
    },
    [nextPage, prevPage, loading, zoomIn, zoomOut, zoom]
  );

  // Pan with mouse drag when zoomed in
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (zoom <= 1) return;
      e.preventDefault();
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY };
      panOffset.current = { ...panRef.current };
    },
    [zoom]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      panRef.current = {
        x: panOffset.current.x + dx,
        y: panOffset.current.y + dy,
      };
      applyTransform(zoom, panRef.current);
    },
    [zoom, applyTransform]
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const isZoomed = zoom !== 1;

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
        ) : imageData ? (
          <img
            ref={imgRef}
            src={imageData}
            alt={`Page ${pageIndex + 1} of ${totalPages}`}
            className="max-h-full max-w-full object-contain rounded-sm shadow-[0_4px_24px_-4px_rgba(44,34,24,0.18)] will-change-transform"
            style={{
              transform: `scale(${zoom}) translate(${panRef.current.x / zoom}px, ${panRef.current.y / zoom}px)`,
            }}
            draggable={false}
          />
        ) : null}
      </div>

      {/* Navigation bar */}
      <div className="shrink-0 border-t border-warm-border bg-surface px-5 py-3 flex items-center gap-3">
        <button
          onClick={prevPage}
          disabled={pageIndex <= 0}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous page"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Prev
        </button>

        <span className="flex-1 text-center text-xs text-ink-muted tabular-nums">
          Page {pageIndex + 1} / {totalPages}
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
          onClick={nextPage}
          disabled={pageIndex >= totalPages - 1}
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
