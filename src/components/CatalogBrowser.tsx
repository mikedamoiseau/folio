import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { friendlyError } from "../lib/errors";
import { pickSupportedOpdsLink } from "../lib/utils";

interface OpdsCatalog {
  name: string;
  url: string;
}

interface OpdsLink {
  href: string;
  mimeType: string;
  rel: string;
}

interface OpdsEntry {
  id: string;
  title: string;
  author: string;
  summary: string;
  coverUrl: string | null;
  links: OpdsLink[];
  navUrl: string | null;
}

interface OpdsFeed {
  title: string;
  entries: OpdsEntry[];
  nextUrl: string | null;
  searchUrl: string | null;
}

interface CatalogBrowserProps {
  onClose: () => void;
  onBookImported: () => void;
}

export default function CatalogBrowser({ onClose, onBookImported }: CatalogBrowserProps) {
  const { t } = useTranslation();
  const [catalogs, setCatalogs] = useState<OpdsCatalog[]>([]);
  const [feed, setFeed] = useState<OpdsFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastActionRef = useRef<(() => void) | null>(null);
  const [history, setHistory] = useState<{ url: string; title: string }[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());

  // Add catalog form
  const [showAddCatalog, setShowAddCatalog] = useState(false);
  const [newCatalogName, setNewCatalogName] = useState("");
  const [newCatalogUrl, setNewCatalogUrl] = useState("");

  // Search (per-catalog and unified)
  const [searchQuery, setSearchQuery] = useState("");
  const [unifiedQuery, setUnifiedQuery] = useState("");
  const [unifiedResults, setUnifiedResults] = useState<OpdsEntry[] | null>(null);
  const [unifiedLoading, setUnifiedLoading] = useState(false);

  const loadCatalogs = useCallback(async () => {
    try {
      const cs = await invoke<OpdsCatalog[]>("get_opds_catalogs");
      setCatalogs(cs);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => { loadCatalogs(); }, [loadCatalogs]);

  const browseTo = useCallback(async (url: string, title?: string) => {
    setLoading(true);
    setError(null);
    lastActionRef.current = () => browseTo(url, title);
    try {
      const f = await invoke<OpdsFeed>("browse_opds", { url });
      setFeed(f);
      setHistory((prev) => [...prev, { url, title: title ?? f.title }]);
    } catch (err) {
      setError(friendlyError(err, t));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const goBack = useCallback(() => {
    if (history.length <= 1) {
      setFeed(null);
      setHistory([]);
      return;
    }
    const newHistory = history.slice(0, -2);
    const prev = history[history.length - 2];
    setHistory(newHistory);
    browseTo(prev.url, prev.title);
  }, [history, browseTo]);

  const handleSearch = useCallback(async () => {
    if (!feed?.searchUrl || !searchQuery.trim()) return;
    const searchUrl = feed.searchUrl;
    const url = searchUrl.replace("{searchTerms}", encodeURIComponent(searchQuery.trim()));
    setLoading(true);
    setError(null);
    try {
      const f = await invoke<OpdsFeed>("browse_opds", { url });
      // Preserve the parent's searchUrl so the search bar stays visible
      if (!f.searchUrl) f.searchUrl = searchUrl;
      setFeed(f);
      setHistory((prev) => [...prev, { url, title: `Search: ${searchQuery}` }]);
    } catch (err) {
      setError(friendlyError(err, t));
    } finally {
      setLoading(false);
    }
  }, [feed, searchQuery]);

  const handleDownload = useCallback(async (entry: OpdsEntry) => {
    // Walk the Folio preference order (EPUB → PDF → CBZ → CBR → AZW3 → MOBI
    // → AZW) and pick the first matching link. If nothing matches, the UI
    // should already have hidden the button; bail out rather than pulling an
    // arbitrary non-importable link.
    const picked = pickSupportedOpdsLink(entry.links);
    if (!picked) return;

    setDownloading(entry.id);
    try {
      // Pass the MIME type so the backend can derive the file extension even
      // when the acquisition URL is opaque (e.g. `/download/123`).
      await invoke("download_opds_book", {
        downloadUrl: picked.link.href,
        mimeType: picked.link.mimeType,
      });
      setDownloadedIds((prev) => new Set(prev).add(entry.id));
      onBookImported();
    } catch (err) {
      setError(t("catalog.downloadFailed", { title: entry.title, error: friendlyError(err, t) }));
    } finally {
      setDownloading(null);
    }
  }, [onBookImported, t]);

  const handleAddCatalog = async () => {
    if (!newCatalogName.trim() || !newCatalogUrl.trim()) return;
    try {
      await invoke("add_opds_catalog", { name: newCatalogName.trim(), url: newCatalogUrl.trim() });
      setNewCatalogName("");
      setNewCatalogUrl("");
      setShowAddCatalog(false);
      await loadCatalogs();
    } catch (err) {
      setError(friendlyError(err, t));
    }
  };

  const handleRemoveCatalog = async (url: string) => {
    try {
      await invoke("remove_opds_catalog", { url });
      await loadCatalogs();
    } catch (err) {
      setError(friendlyError(err, t));
    }
  };

  const handleUnifiedSearch = useCallback(async () => {
    if (!unifiedQuery.trim()) return;
    setUnifiedLoading(true);
    setError(null);
    try {
      const results = await invoke<OpdsEntry[]>("search_all_catalogs", { query: unifiedQuery.trim() });
      setUnifiedResults(results);
    } catch (err) {
      setError(friendlyError(err, t));
    } finally {
      setUnifiedLoading(false);
    }
  }, [unifiedQuery]);

  const clearUnifiedSearch = useCallback(() => {
    setUnifiedResults(null);
    setUnifiedQuery("");
  }, []);

  // Catalog list view
  if (!feed) {
    return (
      <>
        <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-50 animate-fade-in" onClick={onClose} />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
          <div className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-lg pointer-events-auto animate-fade-in max-h-[80vh] flex flex-col">
            <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between shrink-0">
              <h2 className="font-serif text-base font-semibold text-ink">{t("catalog.title")}</h2>
              <button onClick={onClose} className="p-1 text-ink-muted hover:text-ink transition-colors rounded" aria-label={t("common.close")}>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Unified search bar */}
            <div className="px-5 py-3 border-b border-warm-border flex gap-2">
              <input
                type="text" value={unifiedQuery} onChange={(e) => setUnifiedQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleUnifiedSearch(); if (e.key === "Escape" && unifiedResults) clearUnifiedSearch(); }}
                placeholder={t("catalog.searchAllPlaceholder")}
                className="flex-1 text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-1.5 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
              />
              {unifiedResults ? (
                <button onClick={clearUnifiedSearch}
                  className="px-3 py-1.5 text-sm text-ink-muted hover:text-ink rounded-lg transition-colors">
                  {t("common.clear")}
                </button>
              ) : (
                <button onClick={handleUnifiedSearch} disabled={!unifiedQuery.trim() || unifiedLoading}
                  className="px-3 py-1.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40">
                  {t("common.search")}
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto py-2 relative">
              {/* Loading overlay when browsing to a catalog */}
              {loading && !feed && (
                <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                    <span className="text-sm text-ink-muted">{t("common.loading")}</span>
                  </div>
                </div>
              )}
              {/* Unified search results */}
              {unifiedLoading ? (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-ink-muted">{t("catalog.searchingAll")}</p>
                </div>
              ) : unifiedResults ? (
                unifiedResults.length === 0 ? (
                  <div className="flex items-center justify-center py-12">
                    <p className="text-sm text-ink-muted">{t("common.noResults")}</p>
                  </div>
                ) : (
                  unifiedResults.map((entry) => {
                    const picked = pickSupportedOpdsLink(entry.links);
                    const hasDownloads = picked !== null;
                    const isDownloaded = downloadedIds.has(entry.id);
                    const isDownloading = downloading === entry.id;

                    return (
                      <div key={entry.id} className="flex items-start gap-3 px-5 py-3 border-b border-warm-border/50 transition-colors">
                        {entry.coverUrl ? (
                          <img src={entry.coverUrl} alt="" className="w-12 h-16 object-cover rounded shrink-0 bg-warm-subtle"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        ) : (
                          <div className="w-12 h-16 rounded bg-warm-subtle shrink-0 flex items-center justify-center">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-ink-muted/40">
                              <path d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-ink leading-snug">{entry.title}</p>
                          {entry.author && <p className="text-xs text-ink-muted mt-0.5">{entry.author}</p>}
                          {entry.summary && <p className="text-xs text-ink-muted mt-1 line-clamp-2 leading-relaxed">{entry.summary}</p>}
                          {hasDownloads && (
                            <div className="flex items-center gap-2 mt-2">
                              {isDownloaded ? (
                                <span className="text-[11px] text-accent font-medium">{t("catalog.addedToLibrary")}</span>
                              ) : isDownloading ? (
                                <span className="text-[11px] text-ink-muted flex items-center gap-1">
                                  <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                                    <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                                  </svg>
                                  {t("common.downloading")}
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleDownload(entry)}
                                  className="px-2 py-0.5 text-[11px] font-medium text-accent bg-accent-light hover:bg-accent hover:text-white rounded transition-colors"
                                >
                                  + {picked?.label ?? ""}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )
              ) : (
              /* Catalog list (hidden during unified search) */
              <>
              {catalogs.map((cat) => (
                <button
                  key={cat.url}
                  onClick={() => browseTo(cat.url, cat.name)}
                  className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-warm-subtle transition-colors group"
                >
                  <div className="w-8 h-8 rounded-lg bg-accent-light flex items-center justify-center shrink-0">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-accent">
                      <path d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink">{cat.name}</p>
                    <p className="text-[11px] text-ink-muted truncate">{cat.url}</p>
                  </div>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="text-ink-muted shrink-0 group-hover:hidden">
                    <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRemoveCatalog(cat.url); }}
                    className="hidden group-hover:flex p-1 text-ink-muted hover:text-red-500 transition-colors shrink-0"
                    aria-label={t("catalog.removeCatalog", { name: cat.name })}
                    title={t("catalog.removeCatalogTitle")}
                  >
                    <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                      <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </button>
              ))}

              {/* Add custom catalog */}
              {showAddCatalog ? (
                <div className="px-5 py-3 space-y-2 border-t border-warm-border">
                  <input
                    type="text" value={newCatalogName} onChange={(e) => setNewCatalogName(e.target.value)}
                    placeholder={t("catalog.catalogName")} autoFocus
                    className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                  />
                  <input
                    type="url" value={newCatalogUrl} onChange={(e) => setNewCatalogUrl(e.target.value)}
                    placeholder={t("catalog.opdsFeedUrl")}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddCatalog(); }}
                    className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                  />
                  <div className="flex gap-2">
                    <button onClick={handleAddCatalog} disabled={!newCatalogName.trim() || !newCatalogUrl.trim()}
                      className="flex-1 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40">
                      {t("common.add")}
                    </button>
                    <button onClick={() => setShowAddCatalog(false)}
                      className="flex-1 py-1.5 text-xs text-ink-muted hover:text-ink transition-colors">
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowAddCatalog(true)}
                  className="w-full px-5 py-3 text-xs text-ink-muted hover:text-accent hover:bg-warm-subtle transition-colors text-left flex items-center gap-2 border-t border-warm-border">
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                    <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  {t("catalog.addCustomCatalog")}
                </button>
              )}
              </>
              )}
            </div>

            {error && (
              <div className="px-5 py-2 border-t border-warm-border flex items-center gap-2">
                <p className="text-xs text-red-600 flex-1">{error}</p>
                {lastActionRef.current && (
                  <button
                    onClick={() => lastActionRef.current?.()}
                    className="text-xs text-accent hover:text-accent/80 font-medium shrink-0"
                  >
                    {t("common.retry")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // Feed browsing view
  return (
    <>
      <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-50 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-2xl pointer-events-auto animate-fade-in max-h-[85vh] flex flex-col">
          {/* Header */}
          <div className="px-5 py-3 border-b border-warm-border flex items-center gap-3 shrink-0">
            <button onClick={goBack} className="p-1 text-ink-muted hover:text-ink transition-colors rounded" aria-label={t("common.back")}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <h2 className="font-serif text-sm font-semibold text-ink truncate flex-1">{feed.title || t("catalog.catalog")}</h2>
            <button onClick={onClose} className="p-1 text-ink-muted hover:text-ink transition-colors rounded" aria-label={t("common.close")}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* Search bar (if feed has search) */}
          {feed.searchUrl && (
            <div className="px-5 py-2 border-b border-warm-border flex gap-2">
              <input
                type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
                placeholder={t("catalog.searchThisCatalog")}
                className="flex-1 text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-1.5 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
              />
              <button onClick={handleSearch} disabled={!searchQuery.trim()}
                className="px-3 py-1.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40">
                {t("common.search")}
              </button>
            </div>
          )}

          {/* Entries */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-ink-muted">{t("common.loading")}</p>
              </div>
            ) : feed.entries.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-ink-muted">{t("catalog.noEntries")}</p>
              </div>
            ) : (
              feed.entries.map((entry) => {
                const picked = pickSupportedOpdsLink(entry.links);
                const hasDownloads = picked !== null;
                const isNav = !!entry.navUrl && !hasDownloads;
                const isDownloaded = downloadedIds.has(entry.id);
                const isDownloading = downloading === entry.id;

                return (
                  <div
                    key={entry.id}
                    className={`flex items-start gap-3 px-5 py-3 border-b border-warm-border/50 ${isNav ? "hover:bg-warm-subtle cursor-pointer" : ""} transition-colors`}
                    onClick={isNav ? () => browseTo(entry.navUrl!, entry.title) : undefined}
                  >
                    {/* Cover thumbnail — only for book entries, not nav */}
                    {!isNav && entry.coverUrl ? (
                      <img
                        src={entry.coverUrl}
                        alt=""
                        className="w-12 h-16 object-cover rounded shrink-0 bg-warm-subtle"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    ) : !isNav ? (
                      <div className="w-12 h-16 rounded bg-warm-subtle shrink-0 flex items-center justify-center">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-ink-muted/40">
                          <path d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                    ) : null}

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-ink leading-snug">{entry.title}</p>
                      {entry.author && <p className="text-xs text-ink-muted mt-0.5">{entry.author}</p>}
                      {entry.summary && (
                        <p className="text-xs text-ink-muted mt-1 line-clamp-2 leading-relaxed">{entry.summary}</p>
                      )}

                      {/* Download buttons */}
                      {hasDownloads && (
                        <div className="flex items-center gap-2 mt-2">
                          {isDownloaded ? (
                            <span className="text-[11px] text-accent font-medium">{t("catalog.addedToLibrary")}</span>
                          ) : isDownloading ? (
                            <span className="text-[11px] text-ink-muted flex items-center gap-1">
                              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                              </svg>
                              {t("common.downloading")}
                            </span>
                          ) : (
                            picked && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDownload(entry); }}
                                className="px-2 py-0.5 text-[11px] font-medium text-accent bg-accent-light hover:bg-accent hover:text-white rounded transition-colors"
                              >
                                + {picked.label}
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>

                    {/* Nav arrow for sub-catalogs */}
                    {isNav && (
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="text-ink-muted shrink-0 mt-2">
                        <path d="M8 4l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                );
              })
            )}

            {/* Next page */}
            {feed.nextUrl && !loading && (
              <button
                onClick={() => browseTo(feed.nextUrl!)}
                className="w-full py-3 text-sm text-accent hover:bg-warm-subtle transition-colors"
              >
                {t("catalog.loadMore")}
              </button>
            )}
          </div>

          {error && (
            <div className="px-5 py-2 border-t border-warm-border">
              <p className="text-xs text-red-600">{error}</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
