import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import confetti from "canvas-confetti";
import { useFocusTrap } from "../lib/useFocusTrap";
import { formatDuration } from "../lib/utils";
import StarRating from "./StarRating";
import { useToast } from "./Toast";

interface BookCompletionModalProps {
  bookId: string;
  title: string;
  author: string;
  coverPath: string | null;
  readingTimeSecs: number;
  onClose: () => void;
}

export default function BookCompletionModal({
  bookId,
  title,
  author,
  coverPath,
  readingTimeSecs,
  onClose,
}: BookCompletionModalProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const dialogRef = useFocusTrap(onClose);
  const [rating, setRating] = useState(0);
  const [ratingSubmitted, setRatingSubmitted] = useState(false);
  const [visible, setVisible] = useState(false);
  const confettiFired = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!visible || confettiFired.current) return;
    confettiFired.current = true;

    const defaults = { disableForReducedMotion: true, zIndex: 70 };
    const palette = ["#f59e0b", "#fbbf24", "#d97706", "#92400e", "#fcd34d"];

    confetti({ ...defaults, particleCount: 80, spread: 100, origin: { y: 0.4 }, colors: palette });

    setTimeout(() => {
      confetti({ ...defaults, particleCount: 40, angle: 60, spread: 55, origin: { x: 0, y: 0.5 }, colors: palette });
      confetti({ ...defaults, particleCount: 40, angle: 120, spread: 55, origin: { x: 1, y: 0.5 }, colors: palette });
    }, 200);
  }, [visible]);

  const coverSrc = coverPath ? convertFileSrc(coverPath) : null;

  const handleRate = async (value: number | null) => {
    const r = value ?? 0;
    setRating(r);
    if (r > 0) {
      try {
        await invoke("update_book_metadata", {
          bookId,
          title: null,
          author: null,
          coverImagePath: null,
          series: null,
          volume: null,
          language: null,
          publisher: null,
          publishYear: null,
          rating: r,
        });
        setRatingSubmitted(true);
        addToast(t("celebration.ratingSubmitted"), "success");
      } catch {
        addToast(t("celebration.ratingFailed"), "error");
      }
    }
  };

  if (!visible) return null;

  return (
    <>
      <div
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm z-[60] animate-fade-in"
        onClick={onClose}
      />
      <div className="absolute inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("celebration.title")}
          className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-sm pointer-events-auto animate-slide-in-up overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative bg-warm-subtle px-6 pt-8 pb-6 flex flex-col items-center">
            {coverSrc ? (
              <div className="w-24 aspect-[2/3] rounded-lg overflow-hidden shadow-lg mb-4 ring-1 ring-black/5">
                <img src={coverSrc} alt="" className="w-full h-full object-cover" />
              </div>
            ) : (
              <div className="w-24 aspect-[2/3] rounded-lg mb-4 bg-warm-border/30 flex items-center justify-center">
                <span className="text-3xl" aria-hidden="true">📖</span>
              </div>
            )}
            <h2 className="font-serif text-lg font-semibold text-ink text-center leading-snug">
              {t("celebration.heading")}
            </h2>
            <p className="text-sm text-ink-muted text-center mt-1.5 font-medium line-clamp-2">
              {title}
            </p>
            {author && (
              <p className="text-xs text-ink-muted/70 text-center mt-0.5">
                {t("celebration.byAuthor", { author })}
              </p>
            )}
          </div>

          <div className="px-6 py-5 space-y-4">
            {readingTimeSecs > 0 && (
              <div className="text-center">
                <p className="text-[11px] text-ink-muted uppercase tracking-wider mb-1">
                  {t("celebration.totalReadingTime")}
                </p>
                <p className="text-lg font-semibold text-ink tabular-nums">
                  {formatDuration(readingTimeSecs)}
                </p>
              </div>
            )}

            {!ratingSubmitted ? (
              <div className="text-center">
                <p className="text-xs text-ink-muted mb-2">
                  {t("celebration.ratePrompt")}
                </p>
                <div className="flex justify-center">
                  <StarRating value={rating} onChange={handleRate} size="md" />
                </div>
              </div>
            ) : (
              <p className="text-xs text-accent text-center font-medium">
                ✓ {t("celebration.ratingThanks")}
              </p>
            )}
          </div>

          <div className="px-6 pb-5">
            <button
              type="button"
              onClick={onClose}
              className="w-full px-4 py-2.5 bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors text-sm font-medium"
            >
              {t("celebration.close")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
