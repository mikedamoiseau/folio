/**
 * Browser-style back/forward navigation history.
 *
 * Pure data structure — every operation returns a new history value. Generic
 * over a `meta` payload so callers can attach scroll positions or any other
 * context they want to restore on back/forward.
 *
 * Semantics mirror a web browser's history stack:
 *   - pushEntry while not at the head truncates the forward entries.
 *   - Consecutive pushes at the same position collapse into one entry; the
 *     latest meta overwrites the previous one (useful for refreshing scroll
 *     state on the current entry without growing the stack).
 *   - When the entry count exceeds `max`, the oldest entry is evicted.
 */

const DEFAULT_MAX_ENTRIES = 100;

export interface NavigationEntry<M = undefined> {
  /** Chapter index (HTML books) or page index (PDF/CBZ/CBR). */
  position: number;
  /** Optional caller-defined payload (e.g. scroll offset). */
  meta?: M;
}

export interface NavigationHistory<M = undefined> {
  entries: NavigationEntry<M>[];
  /** Index into `entries`; -1 when empty. */
  cursor: number;
  /** Hard cap on entry count; exceeding pushes evict the oldest entry. */
  max: number;
}

export function emptyHistory<M = undefined>(max: number = DEFAULT_MAX_ENTRIES): NavigationHistory<M> {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(`navigationHistory: max must be a positive integer, got ${max}`);
  }
  return { entries: [], cursor: -1, max };
}

export function currentEntry<M>(h: NavigationHistory<M>): NavigationEntry<M> | null {
  return h.cursor >= 0 ? h.entries[h.cursor] : null;
}

export function canGoBack<M>(h: NavigationHistory<M>): boolean {
  return h.cursor > 0;
}

export function canGoForward<M>(h: NavigationHistory<M>): boolean {
  return h.cursor >= 0 && h.cursor < h.entries.length - 1;
}

export function pushEntry<M>(
  h: NavigationHistory<M>,
  entry: NavigationEntry<M>,
): NavigationHistory<M> {
  const head = currentEntry(h);

  // Collapse consecutive same-position pushes — refresh meta in place.
  if (head && head.position === entry.position) {
    const entries = h.entries.slice();
    entries[h.cursor] = { ...entry };
    return { ...h, entries };
  }

  // Truncate any forward entries past the current cursor, then append.
  const truncated = h.entries.slice(0, h.cursor + 1);
  truncated.push({ ...entry });

  // Enforce capacity by dropping the oldest entry.
  while (truncated.length > h.max) {
    truncated.shift();
  }

  return { ...h, entries: truncated, cursor: truncated.length - 1 };
}

export function goBack<M>(
  h: NavigationHistory<M>,
): { history: NavigationHistory<M>; entry: NavigationEntry<M> | null } {
  if (!canGoBack(h)) return { history: h, entry: null };
  const cursor = h.cursor - 1;
  return { history: { ...h, cursor }, entry: h.entries[cursor] };
}

export function goForward<M>(
  h: NavigationHistory<M>,
): { history: NavigationHistory<M>; entry: NavigationEntry<M> | null } {
  if (!canGoForward(h)) return { history: h, entry: null };
  const cursor = h.cursor + 1;
  return { history: { ...h, cursor }, entry: h.entries[cursor] };
}
