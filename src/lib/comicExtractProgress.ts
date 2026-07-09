// Progress-bar state for the progressive comic-open feature (F-4-1).
//
// The backend extracts a comic's pages in the background after
// `prepare_comic` returns (page 0 + the resume page are eager; the rest
// stream in), emitting throttled `comic-extract-progress` events. This
// module owns the pure visibility/count logic for the non-blocking,
// dismissible "preparing pages" bar so it can be unit-tested without
// React or the Tauri event bridge.

export interface ComicExtractProgressState {
  /** Book the current counts belong to; null before any book is bound. */
  bookId: string | null;
  /** Pages extracted so far (clamped to `[0, total]`). */
  loaded: number;
  /** Total pages in the book (0 until the first event arrives). */
  total: number;
  /** True once the user dismisses the bar; stays hidden until reset. */
  dismissed: boolean;
}

export type ComicExtractProgressAction =
  // Bind to a book on open/change: fresh counts, un-dismissed.
  | { type: "reset"; bookId: string }
  // A `comic-extract-progress` event. Events whose `bookId` does not match
  // the bound book are ignored so a stale event from a previous book can
  // never drive this bar.
  | { type: "progress"; bookId: string; loaded: number; total: number }
  // User closed the bar.
  | { type: "dismiss" };

export function initialComicExtractProgress(): ComicExtractProgressState {
  return { bookId: null, loaded: 0, total: 0, dismissed: false };
}

export function comicExtractProgressReducer(
  state: ComicExtractProgressState,
  action: ComicExtractProgressAction,
): ComicExtractProgressState {
  switch (action.type) {
    case "reset":
      return { bookId: action.bookId, loaded: 0, total: 0, dismissed: false };
    case "progress": {
      // Scope to the current book — ignore events for any other book.
      if (action.bookId !== state.bookId) return state;
      const total = Math.max(0, action.total);
      const loaded = Math.max(0, Math.min(action.loaded, total));
      return { ...state, loaded, total };
    }
    case "dismiss":
      return { ...state, dismissed: true };
    default:
      return state;
  }
}

/**
 * The bar shows only while an extraction is genuinely in progress for the
 * bound book and the user hasn't dismissed it. It auto-hides on completion
 * (`loaded >= total`) and never shows before the first event (`total === 0`).
 */
export function isComicExtractProgressVisible(state: ComicExtractProgressState): boolean {
  return !state.dismissed && state.total > 0 && state.loaded < state.total;
}

/** Whole-percent completion, clamped to `[0, 100]`. */
export function comicExtractProgressPercent(loaded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
}
