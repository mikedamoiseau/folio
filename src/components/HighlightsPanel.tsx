import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../lib/useFocusTrap";

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
  const { t } = useTranslation();
  const panelRef = useFocusTrap(onClose);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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
    setDeletingId(id);
    try {
      await invoke("remove_highlight", { highlightId: id });
      await loadHighlights();
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
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
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(md);
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
        className="fixed inset-0 bg-ink/20 backdrop-blur-sm z-10 animate-fade-in"
        onClick={onClose}
      />
      <aside ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="highlights-panel-title" className="fixed right-0 top-0 bottom-0 w-80 max-w-[90vw] bg-surface border-l border-warm-border z-20 flex flex-col shadow-[-4px_0_24px_-4px_rgba(44,34,24,0.12)] animate-slide-in-right">
        <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
          <h2 id="highlights-panel-title" className="font-serif text-base font-semibold text-ink">{t("highlights.title")}</h2>
          <div className="flex items-center gap-2">
            {highlights.length > 0 && (
              <button
                onClick={handleExport}
                className="text-xs text-ink-muted hover:text-accent transition-colors"
                title={t("highlights.exportTitle")}
              >
                {t("highlights.export")}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
              aria-label={t("highlights.closeLabel")}
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
              {t("highlights.empty")}
            </p>
          ) : (
            Object.entries(grouped).map(([chapterStr, chapterHighlights]) => (
              <div key={chapterStr}>
                <button
                  onClick={() => onGoToChapter(Number(chapterStr))}
                  className="w-full px-5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:text-accent transition-colors text-left"
                >
                  {t("highlights.chapterLabel", { number: Number(chapterStr) + 1 })}
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
                          <div className="mt-1.5 space-y-1">
                            <textarea
                              value={noteText}
                              onChange={(e) => setNoteText(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSaveNote(h.id); }}
                              autoFocus
                              rows={3}
                              placeholder={t("highlights.notePlaceholder")}
                              className="w-full text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1.5 text-ink focus:outline-none focus:border-accent resize-y"
                            />
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-ink-muted">{t("highlights.noteSaveHint")}</span>
                              <div className="flex gap-1.5">
                                <button
                                  onClick={() => setEditingNote(null)}
                                  className="text-xs text-ink-muted hover:text-ink"
                                >
                                  {t("common.cancel")}
                                </button>
                                <button
                                  onClick={() => handleSaveNote(h.id)}
                                  className="text-xs text-accent hover:text-accent-hover"
                                >
                                  {t("common.save")}
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : h.note ? (
                          <p
                            className="text-xs text-ink-muted mt-1 italic cursor-pointer hover:text-ink whitespace-pre-line"
                            onClick={() => { setEditingNote(h.id); setNoteText(h.note ?? ""); }}
                          >
                            {h.note}
                          </p>
                        ) : (
                          <button
                            onClick={() => { setEditingNote(h.id); setNoteText(""); }}
                            className="text-[10px] text-ink-muted hover:text-accent mt-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            {t("highlights.addNote")}
                          </button>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteHighlight(h.id)}
                        disabled={deletingId === h.id}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-red-500 transition-all shrink-0 disabled:opacity-50"
                        aria-label={t("highlights.deleteLabel")}
                      >
                        {deletingId === h.id ? (
                          <div className="w-3 h-3 border border-ink-muted/40 border-t-ink-muted rounded-full animate-spin" />
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                            <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        )}
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
