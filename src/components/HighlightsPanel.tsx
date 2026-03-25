import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Highlight {
  id: string;
  bookId: string;
  chapterIndex: number;
  text: string;
  color: string;
  note: string | null;
  startOffset: number;
  endOffset: number;
  createdAt: number;
}

interface HighlightsPanelProps {
  bookId: string;
  onClose: () => void;
  onGoToChapter: (index: number) => void;
}

const HIGHLIGHT_COLORS = [
  { name: "Yellow", value: "#f6c445" },
  { name: "Green", value: "#7bc47f" },
  { name: "Blue", value: "#6ba3d6" },
  { name: "Pink", value: "#e88baf" },
  { name: "Orange", value: "#e8a55d" },
];

export { HIGHLIGHT_COLORS };
export type { Highlight };

export default function HighlightsPanel({ bookId, onClose, onGoToChapter }: HighlightsPanelProps) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");

  const loadHighlights = useCallback(async () => {
    try {
      const hs = await invoke<Highlight[]>("get_highlights", { bookId });
      setHighlights(hs);
    } catch {
      // non-fatal
    }
  }, [bookId]);

  useEffect(() => { loadHighlights(); }, [loadHighlights]);

  const handleDeleteHighlight = async (id: string) => {
    try {
      await invoke("remove_highlight", { highlightId: id });
      await loadHighlights();
    } catch {
      // ignore
    }
  };

  const handleSaveNote = async (id: string) => {
    try {
      await invoke("update_highlight_note", {
        highlightId: id,
        note: noteText.trim() || null,
      });
      setEditingNote(null);
      await loadHighlights();
    } catch {
      // ignore
    }
  };

  const handleExport = async () => {
    try {
      const md = await invoke<string>("export_highlights_markdown", { bookId });
      await navigator.clipboard.writeText(md);
    } catch {
      // ignore
    }
  };

  // Group by chapter
  const grouped = highlights.reduce<Record<number, Highlight[]>>((acc, h) => {
    (acc[h.chapterIndex] ??= []).push(h);
    return acc;
  }, {});

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/20 z-10 animate-fade-in"
        onClick={onClose}
      />
      <aside className="fixed right-0 top-0 bottom-0 w-80 max-w-[90vw] bg-surface border-l border-warm-border z-20 flex flex-col shadow-[-4px_0_24px_-4px_rgba(44,34,24,0.12)] animate-slide-in-right">
        <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
          <h2 className="font-serif text-base font-semibold text-ink">Highlights</h2>
          <div className="flex items-center gap-2">
            {highlights.length > 0 && (
              <button
                onClick={handleExport}
                className="text-xs text-ink-muted hover:text-accent transition-colors"
                title="Copy all as Markdown"
              >
                Export
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
              aria-label="Close highlights"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {highlights.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-muted text-center">
              No highlights yet. Select text while reading to create one.
            </p>
          ) : (
            Object.entries(grouped).map(([chapterStr, chapterHighlights]) => (
              <div key={chapterStr}>
                <button
                  onClick={() => onGoToChapter(Number(chapterStr))}
                  className="w-full px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:text-accent transition-colors text-left"
                >
                  Chapter {Number(chapterStr) + 1}
                </button>
                {chapterHighlights.map((h) => (
                  <div key={h.id} className="group px-5 py-2 hover:bg-warm-subtle transition-colors">
                    <div className="flex items-start gap-2">
                      <span
                        className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                        style={{ backgroundColor: h.color }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-ink leading-snug line-clamp-3">&ldquo;{h.text}&rdquo;</p>
                        {editingNote === h.id ? (
                          <div className="mt-1.5 flex gap-1">
                            <input
                              type="text"
                              value={noteText}
                              onChange={(e) => setNoteText(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") handleSaveNote(h.id); }}
                              autoFocus
                              placeholder="Add a note…"
                              className="flex-1 text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink focus:outline-none focus:border-accent"
                            />
                            <button
                              onClick={() => handleSaveNote(h.id)}
                              className="text-xs text-accent hover:text-accent-hover"
                            >
                              Save
                            </button>
                          </div>
                        ) : h.note ? (
                          <p
                            className="text-xs text-ink-muted mt-1 italic cursor-pointer hover:text-ink"
                            onClick={() => { setEditingNote(h.id); setNoteText(h.note ?? ""); }}
                          >
                            {h.note}
                          </p>
                        ) : (
                          <button
                            onClick={() => { setEditingNote(h.id); setNoteText(""); }}
                            className="text-[10px] text-ink-muted hover:text-accent mt-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            + Add note
                          </button>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteHighlight(h.id)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-red-500 transition-all shrink-0"
                        aria-label="Delete highlight"
                      >
                        <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                          <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
