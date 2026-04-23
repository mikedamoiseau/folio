/**
 * Pure utility functions extracted for testability.
 */

/** Format seconds into human-readable duration (e.g. "5s", "12m", "2h 30m"). */
export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

export interface BookLike {
  id: string;
  title: string;
  author: string;
  format: string;
  added_at: number;
}

/** Filter books by search query, format, and reading status. */
export function filterBooks<T extends BookLike>(
  books: T[],
  search: string,
  filterFormat: string,
  filterStatus: string,
  progressMap: Record<string, number>,
): T[] {
  return books.filter((book) => {
    if (search) {
      const q = search.toLowerCase();
      if (
        !book.title.toLowerCase().includes(q) &&
        !book.author.toLowerCase().includes(q)
      )
        return false;
    }
    if (filterFormat !== "all" && book.format !== filterFormat) return false;
    if (filterStatus !== "all") {
      const pct = progressMap[book.id] ?? 0;
      if (filterStatus === "unread" && pct !== 0) return false;
      if (filterStatus === "in_progress" && (pct === 0 || pct >= 100))
        return false;
      if (filterStatus === "finished" && pct < 100) return false;
    }
    return true;
  });
}

export type SortField =
  | "title"
  | "author"
  | "last_read"
  | "progress"
  | "date_added";

/** Sort books by the given field and direction. */
export function sortBooks<T extends BookLike>(
  books: T[],
  sortBy: SortField,
  sortAsc: boolean,
  progressMap: Record<string, number>,
  lastReadMap: Record<string, number>,
): T[] {
  const dir = sortAsc ? 1 : -1;
  return [...books].sort((a, b) => {
    switch (sortBy) {
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "author":
        return dir * a.author.localeCompare(b.author);
      case "last_read":
        return (
          dir * ((lastReadMap[a.id] ?? 0) - (lastReadMap[b.id] ?? 0))
        );
      case "progress":
        return (
          dir * ((progressMap[a.id] ?? 0) - (progressMap[b.id] ?? 0))
        );
      case "date_added":
      default:
        return dir * (a.added_at - b.added_at);
    }
  });
}

/** Group items by a key extracted from each item. */
export function groupBy<T>(
  items: T[],
  keyFn: (item: T) => string | number,
): Record<string | number, T[]> {
  return items.reduce<Record<string | number, T[]>>((acc, item) => {
    const key = keyFn(item);
    (acc[key] ??= []).push(item);
    return acc;
  }, {});
}

/** Clamp a number between min and max (inclusive). */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const SUPPORTED_EXTENSIONS = [".epub", ".cbz", ".cbr", ".pdf"];

/** Check if a filename has a supported ebook extension. */
export function isSupportedFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface MetadataPill {
  label: string;
}

/** Given a page index and total pages, return the left and right pages for a dual-page spread.
 *  Cover (index 0) is always solo. After that, pages pair as 1-2, 3-4, 5-6, etc.
 *  If the last page has no partner (odd total), it displays solo (right: null). */
export function getSpreadPages(
  pageIndex: number,
  totalPages: number,
): { left: number; right: number | null } {
  // Cover is always solo
  if (pageIndex === 0) return { left: 0, right: null };

  // Find the left page of the pair containing pageIndex
  // After cover: pairs are (1,2), (3,4), (5,6), ...
  // Left page of a pair is always odd-indexed
  const left = pageIndex % 2 === 1 ? pageIndex : pageIndex - 1;
  const right = left + 1;

  // If the right page is beyond total, it's solo
  if (right >= totalPages) return { left, right: null };

  return { left, right };
}

export function formatMetadataPills(meta: {
  language?: string | null;
  publishYear?: number | null;
  series?: string | null;
  volume?: number | null;
}): MetadataPill[] {
  const pills: MetadataPill[] = [];
  if (meta.language) pills.push({ label: meta.language });
  if (meta.publishYear != null) pills.push({ label: String(meta.publishYear) });
  if (meta.series) {
    const seriesLabel = meta.volume != null ? `${meta.series} #${meta.volume}` : meta.series;
    pills.push({ label: seriesLabel });
  }
  return pills;
}

export interface OpdsLinkLike {
  href: string;
  mimeType: string;
}

// Format preference for OPDS acquisition: EPUB first (best reflowable
// rendering), then PDF/CBZ/CBR for page-based books, then MOBI/AZW3/AZW.
// `ext` is the canonical extension used to filter against the backend's
// get_supported_formats() list; `mimeNeedles` / `extNeedles` are loose
// substring matches tolerating the MIME + URL variations seen in the wild.
const OPDS_FORMATS: Array<{
  label: string;
  ext: string;
  mimeNeedles: string[];
  extNeedles: string[];
}> = [
  { label: "EPUB", ext: "epub", mimeNeedles: ["epub"], extNeedles: ["epub"] },
  { label: "PDF", ext: "pdf", mimeNeedles: ["pdf"], extNeedles: ["pdf"] },
  { label: "CBZ", ext: "cbz", mimeNeedles: ["cbz", "comicbook+zip"], extNeedles: ["cbz"] },
  { label: "CBR", ext: "cbr", mimeNeedles: ["cbr", "comicbook-rar"], extNeedles: ["cbr"] },
  { label: "AZW3", ext: "azw3", mimeNeedles: ["vnd.amazon.ebook", "azw3"], extNeedles: ["azw3"] },
  { label: "MOBI", ext: "mobi", mimeNeedles: ["mobipocket", "mobi"], extNeedles: ["mobi"] },
  { label: "AZW", ext: "azw", mimeNeedles: ["azw"], extNeedles: ["azw"] },
];

function matchesFormat(
  link: OpdsLinkLike,
  mimeNeedles: string[],
  extNeedles: string[],
): boolean {
  const mime = link.mimeType.toLowerCase();
  const href = link.href.toLowerCase();
  return (
    mimeNeedles.some((n) => mime.includes(n)) ||
    extNeedles.some((n) => href.includes(`.${n}`))
  );
}

/**
 * Pick the best OPDS acquisition link for import. Walks the Folio preference
 * order and returns the first matching link along with a human-readable
 * label. When `allowedExtensions` is supplied (e.g. the set returned by the
 * backend's get_supported_formats command), formats not in the allowlist are
 * skipped — this prevents the UI from offering e.g. `+ MOBI` on builds that
 * weren't compiled with the `mobi` feature.
 *
 * Returns null when no supported + allowed link is found; callers should
 * hide the download action rather than pulling an arbitrary link.
 */
export function pickSupportedOpdsLink<T extends OpdsLinkLike>(
  links: T[],
  allowedExtensions?: Set<string>,
): { link: T; label: string } | null {
  for (const { label, ext, mimeNeedles, extNeedles } of OPDS_FORMATS) {
    if (allowedExtensions && !allowedExtensions.has(ext)) continue;
    const match = links.find((l) => matchesFormat(l, mimeNeedles, extNeedles));
    if (match) return { link: match, label };
  }
  return null;
}

/**
 * Patterns that are dangerous in user-supplied CSS.
 * Blocks data exfiltration (url, @import), script execution (expression,
 * javascript:, -moz-binding), and external resource loading.
 */
const DANGEROUS_CSS_PATTERNS = [
  /url\s*\(/gi,
  /@import/gi,
  /expression\s*\(/gi,
  /javascript\s*:/gi,
  /-moz-binding/gi,
  /behavior\s*:/gi,
  /@font-face/gi,
  /@namespace/gi,
  /\\[0-9a-fA-F]/g, // CSS escape sequences used to bypass filters
];

/** Sanitize user-supplied custom CSS by removing dangerous constructs. */
export function sanitizeCss(css: string): string {
  let sanitized = css;
  for (const pattern of DANGEROUS_CSS_PATTERNS) {
    sanitized = sanitized.replace(pattern, "/* blocked */");
  }
  return sanitized;
}
