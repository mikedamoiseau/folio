import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useFocusTrap } from "../lib/useFocusTrap";
import { boxIntervalDays, matchesVocabularyQuery, vocabularyPosLabelKey, type VocabularyWord } from "../lib/vocabulary";
import ConfirmDialog from "./ConfirmDialog";

// A generous cap on how many due cards one review session pulls at once —
// the table is small (personal vocabulary, not a bulk import), so this is
// just a safety bound rather than real pagination.
const REVIEW_LIMIT = 200;

interface VocabularyPanelProps {
  onClose: () => void;
}

export default function VocabularyPanel({ onClose }: VocabularyPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const panelRef = useFocusTrap(onClose);

  const [words, setWords] = useState<VocabularyWord[] | null>(null);
  const [dueWords, setDueWords] = useState<VocabularyWord[]>([]);
  const [view, setView] = useState<"list" | "review">("list");
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [query, setQuery] = useState("");

  const loadWords = useCallback(async () => {
    try {
      const list = await invoke<VocabularyWord[]>("list_vocabulary");
      setWords(list);
    } catch {
      setWords([]);
    }
  }, []);

  const loadDue = useCallback(async () => {
    try {
      const due = await invoke<VocabularyWord[]>("get_due_vocabulary", { limit: REVIEW_LIMIT });
      setDueWords(due);
    } catch {
      setDueWords([]);
    }
  }, []);

  useEffect(() => {
    loadWords();
    loadDue();
  }, [loadWords, loadDue]);

  const handleDelete = async (id: string) => {
    try {
      await invoke("delete_vocabulary_word", { id });
    } catch {
      // non-fatal — the row just won't disappear until the next refresh
    }
    loadWords();
    loadDue();
  };

  const handleClearAll = async () => {
    try {
      await invoke("clear_vocabulary");
    } catch {
      // non-fatal
    }
    setConfirmClearAll(false);
    loadWords();
    loadDue();
  };

  // Jump to a word's source location in the reader. Omitted entirely for
  // rows whose source book was deleted (word.bookId === null) — the caller
  // only wires onJump when a bookId is present.
  const handleJump = (word: VocabularyWord) => {
    if (!word.bookId) return;
    navigate(`/reader/${word.bookId}`, {
      state: { chapterIndex: word.chapterIndex ?? 0, offset: word.startOffset ?? null },
    });
    onClose();
  };

  const filteredWords = words?.filter((w) => matchesVocabularyQuery(w, query)) ?? null;

  // ---- Review session ----
  const [reviewQueue, setReviewQueue] = useState<VocabularyWord[]>([]);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const startReview = () => {
    setReviewQueue(dueWords);
    setReviewTotal(dueWords.length);
    setFlipped(false);
    setView("review");
  };

  const backToList = () => {
    setView("list");
    loadDue(); // due count may have changed after reviewing
  };

  const currentCard = reviewQueue[0] ?? null;

  const handleAnswer = async (correct: boolean) => {
    if (!currentCard || submitting) return;
    setSubmitting(true);
    try {
      await invoke("record_vocabulary_review", { id: currentCard.id, correct });
    } catch {
      // best-effort — the card still advances locally either way
    }
    setReviewQueue((q) => q.slice(1));
    setFlipped(false);
    setSubmitting(false);
    loadWords(); // keep seenCount/box in sync for when the user returns to the list
  };

  const answeredCount = reviewTotal - reviewQueue.length;
  const progressCurrent = Math.min(answeredCount + 1, reviewTotal);

  return (
    <>
      <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-50 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("vocabulary.title")}
          className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-lg pointer-events-auto animate-fade-in max-h-[80vh] flex flex-col"
        >
          <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between shrink-0">
            <h2 className="font-serif text-base font-semibold text-ink">{t("vocabulary.title")}</h2>
            <button
              onClick={onClose}
              className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
              aria-label={t("common.close")}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {words === null ? (
            <div className="px-5 py-8 text-center text-sm text-ink-muted">{t("common.loading")}</div>
          ) : view === "review" ? (
            <ReviewView
              currentCard={currentCard}
              progressCurrent={progressCurrent}
              reviewTotal={reviewTotal}
              flipped={flipped}
              submitting={submitting}
              onFlip={() => setFlipped(true)}
              onAnswer={handleAnswer}
              onBackToList={backToList}
            />
          ) : (
            <>
              <div className="px-5 py-3 border-b border-warm-border flex items-center justify-between gap-2 shrink-0">
                <button
                  onClick={startReview}
                  disabled={dueWords.length === 0}
                  className="px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {t("vocabulary.reviewDue", { count: dueWords.length })}
                </button>
                {words.length > 0 && (
                  <button
                    onClick={() => setConfirmClearAll(true)}
                    className="text-xs text-ink-muted hover:text-red-500 transition-colors"
                  >
                    {t("vocabulary.clearAll")}
                  </button>
                )}
              </div>

              {words.length === 0 ? (
                <div className="flex-1 overflow-y-auto">
                  <p className="px-5 py-8 text-sm text-ink-muted text-center">{t("vocabulary.empty")}</p>
                </div>
              ) : (
                <>
                  <div className="px-5 py-2.5 border-b border-warm-border shrink-0">
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t("vocabulary.filterPlaceholder")}
                      className="w-full px-3 py-1.5 text-sm bg-warm-subtle border border-warm-border rounded-lg text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent/40"
                    />
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {filteredWords && filteredWords.length === 0 ? (
                      <p className="px-5 py-8 text-sm text-ink-muted text-center">{t("vocabulary.noMatches")}</p>
                    ) : (
                      <div className="divide-y divide-warm-border">
                        {filteredWords?.map((w) => (
                          <WordRow
                            key={w.id}
                            word={w}
                            onDelete={() => handleDelete(w.id)}
                            onJump={w.bookId ? () => handleJump(w) : undefined}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {confirmClearAll && (
        <ConfirmDialog
          title={t("vocabulary.clearAllConfirmTitle")}
          message={t("vocabulary.clearAllConfirmMessage")}
          confirmLabel={t("vocabulary.clearAll")}
          onConfirm={handleClearAll}
          onCancel={() => setConfirmClearAll(false)}
        />
      )}
    </>
  );
}

function WordRow({ word, onDelete, onJump }: { word: VocabularyWord; onDelete: () => void; onJump?: () => void }) {
  const { t } = useTranslation();
  const posKey = vocabularyPosLabelKey(word.pos);
  const jumpable = Boolean(onJump);

  return (
    <div
      role={jumpable ? "button" : undefined}
      tabIndex={jumpable ? 0 : undefined}
      onClick={jumpable ? onJump : undefined}
      onKeyDown={
        jumpable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onJump?.();
              }
            }
          : undefined
      }
      title={!jumpable ? t("vocabulary.sourceBookGone") : undefined}
      className={`group px-5 py-3 hover:bg-warm-subtle transition-colors ${jumpable ? "cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus:outline-none" : ""}`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-ink">{word.word}</span>
            {posKey && <span className="text-[11px] italic text-ink-muted">{t(posKey)}</span>}
            {word.word !== word.lemma && (
              <span className="text-xs text-ink-muted">{t("vocabulary.lemmaNote", { word: word.word, lemma: word.lemma })}</span>
            )}
          </div>
          <p className="text-xs text-ink-muted mt-0.5 leading-snug">{word.definition}</p>
          {word.bookTitle && (
            <p className="text-[11px] text-ink-muted/80 mt-0.5">{t("vocabulary.fromBook", { book: word.bookTitle })}</p>
          )}
          <p className="text-[10px] text-ink-muted/60 mt-0.5">{t("vocabulary.seenCount", { count: word.seenCount })}</p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 p-1 text-ink-muted hover:text-red-500 transition-all shrink-0"
          aria-label={t("vocabulary.deleteLabel", { word: word.word })}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path
              d="M4 6h12M8 6V4.5A1.5 1.5 0 019.5 3h1A1.5 1.5 0 0112 4.5V6m-6.5 0l.6 10.2a1.5 1.5 0 001.5 1.4h4.8a1.5 1.5 0 001.5-1.4L14.5 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

interface ReviewViewProps {
  currentCard: VocabularyWord | null;
  progressCurrent: number;
  reviewTotal: number;
  flipped: boolean;
  submitting: boolean;
  onFlip: () => void;
  onAnswer: (correct: boolean) => void;
  onBackToList: () => void;
}

function ReviewView({
  currentCard,
  progressCurrent,
  reviewTotal,
  flipped,
  submitting,
  onFlip,
  onAnswer,
  onBackToList,
}: ReviewViewProps) {
  const { t } = useTranslation();

  if (!currentCard) {
    return (
      <div className="px-5 py-10 flex flex-col items-center gap-4 text-center">
        <p className="text-sm text-ink">{t("vocabulary.reviewDone")}</p>
        <button
          onClick={onBackToList}
          className="px-3 py-1.5 text-xs font-medium bg-warm-subtle text-ink rounded-lg hover:bg-warm-border transition-colors"
        >
          {t("vocabulary.backToList")}
        </button>
      </div>
    );
  }

  const correctInDays = boxIntervalDays(Math.min(currentCard.box + 1, 5));
  const missedInDays = boxIntervalDays(1);

  return (
    <div className="px-5 py-5 flex flex-col gap-4">
      <p className="text-xs text-ink-muted text-center">
        {t("vocabulary.reviewProgress", { current: progressCurrent, total: reviewTotal })}
      </p>

      <div className="bg-warm-subtle rounded-xl px-5 py-8 text-center min-h-[10rem] flex flex-col items-center justify-center gap-3">
        <p className="text-xl font-serif font-semibold text-ink">{currentCard.word}</p>

        {!flipped ? (
          <button
            onClick={onFlip}
            className="mt-2 px-4 py-1.5 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
          >
            {t("vocabulary.flip")}
          </button>
        ) : (
          <div className="text-left w-full space-y-1.5">
            <p className="text-sm text-ink">{currentCard.definition}</p>
            {currentCard.contextSentence && (
              <p className="text-xs italic text-ink-muted">“{currentCard.contextSentence}”</p>
            )}
            {currentCard.bookTitle && (
              <p className="text-xs text-ink-muted">{t("vocabulary.fromBook", { book: currentCard.bookTitle })}</p>
            )}
          </div>
        )}
      </div>

      {flipped && (
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => onAnswer(false)}
            disabled={submitting}
            className="flex flex-col items-center px-4 py-2 text-sm font-medium bg-warm-subtle text-ink rounded-lg hover:bg-warm-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("vocabulary.missed")}
            <span className="text-[10px] text-ink-muted font-normal">{t("vocabulary.nextInDays", { count: missedInDays })}</span>
          </button>
          <button
            onClick={() => onAnswer(true)}
            disabled={submitting}
            className="flex flex-col items-center px-4 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("vocabulary.gotIt")}
            <span className="text-[10px] text-white/80 font-normal">{t("vocabulary.nextInDays", { count: correctInDays })}</span>
          </button>
        </div>
      )}

      <button onClick={onBackToList} className="text-xs text-ink-muted hover:text-ink transition-colors self-center">
        {t("vocabulary.backToList")}
      </button>
    </div>
  );
}
