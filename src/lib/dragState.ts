/**
 * Shared drag state for book-to-collection drag operations.
 * Uses a module-level variable so both Library and CollectionsSidebar
 * can access it without React context overhead.
 */
let draggedBookId: string | null = null;
let draggedCoverSrc: string | null = null;
let listeners: Array<() => void> = [];

export function startDrag(bookId: string, coverSrc?: string) {
  draggedBookId = bookId;
  draggedCoverSrc = coverSrc ?? null;
  listeners.forEach((fn) => fn());
}

export function endDrag() {
  draggedBookId = null;
  draggedCoverSrc = null;
  listeners.forEach((fn) => fn());
}

export function getDraggedBookId(): string | null {
  return draggedBookId;
}

export function getDraggedCoverSrc(): string | null {
  return draggedCoverSrc;
}

export function isDragging(): boolean {
  return draggedBookId !== null;
}

export function subscribe(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

// ---- Suppress-next-outside-click ----
// A completed book→collection drop fires mousedown on a grid card and mouseup
// on the (portalled) panel row; the browser targets the resulting click at
// their common ancestor — usually <body> — which the panel's outside-click
// listener would otherwise read as "click outside → close". The drop handler
// sets this flag so that trailing click is swallowed instead. The click is not
// guaranteed (the webview may cancel it after pointer movement), so the flag
// also self-clears on the next tick to avoid swallowing a later genuine click.
let suppressOutsideClick = false;
let suppressTimer: ReturnType<typeof setTimeout> | null = null;

// The gesture's trailing click fires within a few ms of mouseup, so this
// window comfortably covers it while clearing well before any deliberate
// later click. A 0ms timer could lose the race and clear before the trailing
// click arrives (notably in a webview that dispatches it in a separate task).
const SUPPRESS_WINDOW_MS = 250;

export function suppressNextOutsideClickClose() {
  suppressOutsideClick = true;
  if (suppressTimer) clearTimeout(suppressTimer);
  suppressTimer = setTimeout(() => {
    suppressOutsideClick = false;
    suppressTimer = null;
  }, SUPPRESS_WINDOW_MS);
}

export function consumeSuppressOutsideClick(): boolean {
  if (!suppressOutsideClick) return false;
  suppressOutsideClick = false;
  if (suppressTimer) {
    clearTimeout(suppressTimer);
    suppressTimer = null;
  }
  return true;
}
