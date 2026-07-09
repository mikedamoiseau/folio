// Shared progress-bar state for the background page-prerender bars.
//
// Originally the progressive comic-open feature (F-4-1): the backend
// extracts a comic's pages in the background after `prepare_comic` returns
// (page 0 + the resume page are eager; the rest stream in), emitting
// throttled `comic-extract-progress` events. F-4-5 reuses this exact state
// for the PDF background prerender (`pdf-prerender-progress`) — the
// visibility/dismiss logic is format-agnostic, so both bars share it (the
// only per-format difference is the label string, chosen at the component).
//
// This module owns the pure visibility/count logic for the non-blocking,
// dismissible "preparing/caching pages" bar so it can be unit-tested without
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
  /**
   * True once a `settle` terminal has fired; hides the bar even at PARTIAL
   * coverage (`loaded < total`). F-4-5: the PDF prerender's guaranteed
   * terminal event can settle below 100% when the cache size bound stopped
   * the pass early — honest partial coverage, not an error — so the
   * `loaded < total` rule alone would leave the bar stuck. Cleared by a later
   * `progress` event (self-heals a premature idle-timer settle) but not by
   * `dismiss`. The comic path never dispatches `settle` (it always reaches
   * 100%), so its behavior is unchanged.
   */
  settled: boolean;
}

export type ComicExtractProgressAction =
  // Bind to a book on open/change: fresh counts, un-dismissed, un-settled.
  | { type: "reset"; bookId: string }
  // A progress event. Events whose `bookId` does not match the bound book are
  // ignored so a stale event from a previous book can never drive this bar.
  | { type: "progress"; bookId: string; loaded: number; total: number }
  // User closed the bar.
  | { type: "dismiss" }
  // Prerender pass ended (terminal event, incl. honest partial coverage) —
  // hide the bar regardless of `loaded`/`total`.
  | { type: "settle" };

export function initialComicExtractProgress(): ComicExtractProgressState {
  return { bookId: null, loaded: 0, total: 0, dismissed: false, settled: false };
}

export function comicExtractProgressReducer(
  state: ComicExtractProgressState,
  action: ComicExtractProgressAction,
): ComicExtractProgressState {
  switch (action.type) {
    case "reset":
      return { bookId: action.bookId, loaded: 0, total: 0, dismissed: false, settled: false };
    case "progress": {
      // Scope to the current book — ignore events for any other book.
      if (action.bookId !== state.bookId) return state;
      const total = Math.max(0, action.total);
      const loaded = Math.max(0, Math.min(action.loaded, total));
      // A live event means the pass is NOT over, so clear any `settled` set by
      // the idle timer — this self-heals a premature settle (e.g. a slow PDF
      // whose throttled events fell more than the idle window apart) by
      // re-showing the bar. The genuine terminal event is the LAST one, so
      // nothing clears the settle that legitimately hides a partial pass.
      // (`dismissed` is deliberately NOT cleared: a user close stays closed.)
      return { ...state, loaded, total, settled: false };
    }
    case "dismiss":
      return { ...state, dismissed: true };
    case "settle":
      return { ...state, settled: true };
    default:
      return state;
  }
}

/**
 * The bar shows only while a prerender pass is genuinely in progress for the
 * bound book and the user hasn't dismissed it. It auto-hides on completion
 * (`loaded >= total`), once the pass has `settled` (see `settled`), and never
 * shows before the first event (`total === 0`).
 */
export function isComicExtractProgressVisible(state: ComicExtractProgressState): boolean {
  return !state.dismissed && !state.settled && state.total > 0 && state.loaded < state.total;
}

/** Whole-percent completion, clamped to `[0, 100]`. */
export function comicExtractProgressPercent(loaded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
}
