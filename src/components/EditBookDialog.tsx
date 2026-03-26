import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface Tag {
  id: string;
  name: string;
}

interface OpenLibraryResult {
  key: string;
  title: string;
  author: string;
  description: string | null;
  genres: string[];
  rating: number | null;
  isbn: string | null;
  coverUrl: string | null;
}

interface EditBookDialogProps {
  bookId: string;
  initialTitle: string;
  initialAuthor: string;
  description?: string | null;
  genres?: string | null;
  rating?: number | null;
  openlibraryKey?: string | null;
  initialSeries?: string | null;
  initialVolume?: number | null;
  initialLanguage?: string | null;
  initialPublisher?: string | null;
  initialPublishYear?: number | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditBookDialog({
  bookId,
  initialTitle,
  initialAuthor,
  description: initialDescription,
  genres: initialGenres,
  rating: initialRating,
  openlibraryKey: initialOlKey,
  initialSeries,
  initialVolume,
  initialLanguage,
  initialPublisher,
  initialPublishYear,
  onClose,
  onSaved,
}: EditBookDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [author, setAuthor] = useState(initialAuthor);
  const [series, setSeries] = useState(initialSeries ?? "");
  const [volume, setVolume] = useState<string>(initialVolume != null ? String(initialVolume) : "");
  const [language, setLanguage] = useState(initialLanguage ?? "");
  const [publisher, setPublisher] = useState(initialPublisher ?? "");
  const [publishYear, setPublishYear] = useState<string>(initialPublishYear != null ? String(initialPublishYear) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OpenLibrary
  const [olResults, setOlResults] = useState<OpenLibraryResult[]>([]);
  const [olSearching, setOlSearching] = useState(false);
  const [olEnriched, setOlEnriched] = useState(!!initialOlKey);
  const [bookDescription, setBookDescription] = useState(initialDescription ?? "");
  const [bookGenres, setBookGenres] = useState<string[]>(() => {
    try { return initialGenres ? JSON.parse(initialGenres) : []; } catch { return []; }
  });
  const [bookRating, setBookRating] = useState(initialRating);

  // Tags
  const [bookTags, setBookTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagInput, setTagInput] = useState("");

  const loadTags = useCallback(async () => {
    try {
      const [bt, at] = await Promise.all([
        invoke<Tag[]>("get_book_tags", { bookId }),
        invoke<Tag[]>("get_all_tags"),
      ]);
      setBookTags(bt);
      setAllTags(at);
    } catch {
      // non-fatal
    }
  }, [bookId]);

  useEffect(() => { loadTags(); }, [loadTags]);

  const suggestions = tagInput.trim()
    ? allTags
        .filter((t) => t.name.toLowerCase().includes(tagInput.toLowerCase()) && !bookTags.some((bt) => bt.id === t.id))
        .slice(0, 5)
    : [];

  const handleAddTag = async (name: string) => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed || bookTags.some((t) => t.name.toLowerCase() === trimmed)) return;
    try {
      await invoke("add_tag_to_book", { bookId, tagName: trimmed });
      setTagInput("");
      await loadTags();
    } catch {
      // ignore
    }
  };

  const handleRemoveTag = async (tagId: string) => {
    try {
      await invoke("remove_tag_from_book", { bookId, tagId });
      await loadTags();
    } catch {
      // ignore
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await invoke("update_book_metadata", {
        bookId,
        title: title !== initialTitle ? title : null,
        author: author !== initialAuthor ? author : null,
        series: series !== (initialSeries ?? "") ? (series || null) : null,
        volume: volume !== String(initialVolume ?? "") ? (volume ? parseInt(volume) : null) : null,
        language: language !== (initialLanguage ?? "") ? (language || null) : null,
        publisher: publisher !== (initialPublisher ?? "") ? (publisher || null) : null,
        publishYear: publishYear !== String(initialPublishYear ?? "") ? (publishYear ? parseInt(publishYear) : null) : null,
      });
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleOlSearch = async () => {
    setOlSearching(true);
    setError(null);
    try {
      const results = await invoke<OpenLibraryResult[]>("search_openlibrary", {
        title,
        author: author || null,
      });
      setOlResults(results);
    } catch (err) {
      setError(String(err));
    } finally {
      setOlSearching(false);
    }
  };

  const handleOlEnrich = async (result: OpenLibraryResult) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<{
        description: string | null;
        genres: string | null;
        rating: number | null;
      }>("enrich_book_from_openlibrary", {
        bookId,
        openlibraryKey: result.key,
      });
      setBookDescription(updated.description ?? "");
      try { setBookGenres(updated.genres ? JSON.parse(updated.genres) : []); } catch { setBookGenres([]); }
      setBookRating(updated.rating);
      setOlEnriched(true);
      setOlResults([]);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleChangeCover = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });
      if (!selected) return;
      setSaving(true);
      setError(null);
      await invoke("update_book_metadata", {
        bookId,
        coverImagePath: selected,
      });
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-ink/30 z-50 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-sm pointer-events-auto animate-fade-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-4 border-b border-warm-border">
            <h2 className="font-serif text-base font-semibold text-ink">Edit Book</h2>
          </div>

          <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1">Author</label>
              <input
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink focus:outline-none focus:border-accent"
              />
            </div>

            {/* Series & Volume - inline row */}
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-ink-muted mb-1">Series</label>
                <input
                  type="text"
                  value={series}
                  onChange={(e) => setSeries(e.target.value)}
                  placeholder="e.g. Aria"
                  className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                />
              </div>
              <div className="w-20">
                <label className="block text-xs font-medium text-ink-muted mb-1">Vol.</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={volume}
                  onChange={(e) => setVolume(e.target.value.replace(/\D/g, ""))}
                  placeholder="#"
                  className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                />
              </div>
            </div>

            {/* Language & Year - inline row */}
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-ink-muted mb-1">Language</label>
                <input
                  type="text"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  placeholder="e.g. fr, en"
                  className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                />
              </div>
              <div className="w-24">
                <label className="block text-xs font-medium text-ink-muted mb-1">Year</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={publishYear}
                  onChange={(e) => setPublishYear(e.target.value.replace(/\D/g, ""))}
                  placeholder="2024"
                  className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                />
              </div>
            </div>

            {/* Publisher */}
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1">Publisher</label>
              <input
                type="text"
                value={publisher}
                onChange={(e) => setPublisher(e.target.value)}
                className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
              />
            </div>

            {/* Tags */}
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1">Tags</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {bookTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent-light text-accent text-xs rounded-full"
                  >
                    {tag.name}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag.id)}
                      className="hover:text-accent-hover"
                      aria-label={`Remove tag ${tag.name}`}
                    >
                      <svg width="10" height="10" viewBox="0 0 20 20" fill="none">
                        <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && tagInput.trim()) {
                      e.preventDefault();
                      handleAddTag(tagInput);
                    }
                  }}
                  placeholder="Add a tag…"
                  className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                />
                {suggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-warm-border rounded-lg shadow-lg z-10 py-1">
                    {suggestions.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => handleAddTag(tag.name)}
                        className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-warm-subtle transition-colors"
                      >
                        {tag.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={handleChangeCover}
              disabled={saving}
              className="w-full py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors border border-dashed border-warm-border"
            >
              Change cover image…
            </button>

            {/* OpenLibrary enrichment */}
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1">Metadata from OpenLibrary</label>
              {olEnriched && bookDescription ? (
                <div className="space-y-2">
                  <p className="text-xs text-ink leading-relaxed line-clamp-4">{bookDescription}</p>
                  {bookGenres.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {bookGenres.slice(0, 6).map((g) => (
                        <span key={g} className="px-1.5 py-0.5 text-[10px] bg-warm-subtle rounded text-ink-muted">{g}</span>
                      ))}
                    </div>
                  )}
                  {bookRating != null && (
                    <p className="text-xs text-ink-muted">Rating: {bookRating.toFixed(1)} / 5</p>
                  )}
                </div>
              ) : olResults.length > 0 ? (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {olResults.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => handleOlEnrich(r)}
                      disabled={saving}
                      className="w-full text-left p-2 bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors flex items-start gap-2"
                    >
                      {r.coverUrl && (
                        <img src={r.coverUrl} alt="" className="w-8 h-11 object-cover rounded shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-ink truncate">{r.title}</p>
                        <p className="text-[10px] text-ink-muted truncate">{r.author}</p>
                        {r.rating != null && (
                          <p className="text-[10px] text-ink-muted">{r.rating.toFixed(1)} / 5</p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleOlSearch}
                  disabled={olSearching || saving}
                  className="w-full py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors border border-dashed border-warm-border disabled:opacity-40"
                >
                  {olSearching ? "Searching…" : "Look up on OpenLibrary"}
                </button>
              )}
            </div>

            {error && (
              <p className="text-xs text-red-600">{error}</p>
            )}
          </div>

          <div className="px-5 py-4 border-t border-warm-border flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 text-sm text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || (!title.trim())}
              className="flex-1 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
