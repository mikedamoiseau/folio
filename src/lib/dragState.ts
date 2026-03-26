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
