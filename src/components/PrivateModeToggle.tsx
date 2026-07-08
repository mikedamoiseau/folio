import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrivateMode } from "../hooks/usePrivateMode";

/**
 * App-wide "Don't track this session" control (B-M2). Mounted once in the
 * library header and once in the reader header (primary pane only, so
 * split view's two panes share a single control for the one backend flag
 * — see `ReaderPane`). Both mounts independently reflect the same shared
 * backend state via `usePrivateMode`.
 *
 * The button itself doubles as the persistent indicator (Decision 6):
 * its color and label change the instant tracking is paused, whether or
 * not the info popover is open. The popover enumerates exactly what
 * pauses and what keeps saving, and holds the actual on/off switch.
 */
export default function PrivateModeToggle() {
  const { t } = useTranslation();
  const { enabled, loading, toggle } = usePrivateMode();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = enabled ? t("privateMode.indicatorLabel") : t("privateMode.buttonLabel");

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={loading}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={`flex items-center gap-1.5 p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50 ${
          enabled
            ? "text-accent bg-accent-light"
            : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
        }`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <path d="M2 2l20 20" />
        </svg>
        {enabled && (
          <span className="text-xs font-medium whitespace-nowrap">
            {t("privateMode.indicatorBadge")}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("privateMode.title")}
          className="absolute right-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] bg-surface border border-warm-border rounded-xl shadow-lg z-50 p-3.5 text-sm animate-fade-in"
        >
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <p className="font-medium text-ink">{t("privateMode.title")}</p>
              <p className="text-[11px] text-ink-muted/70 mt-0.5">{t("privateMode.subtitle")}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={t("privateMode.buttonLabel")}
              disabled={loading}
              onClick={() => toggle()}
              className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${
                enabled ? "bg-accent" : "bg-warm-border"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  enabled ? "translate-x-4" : ""
                }`}
              />
            </button>
          </div>

          <p className="text-[11px] font-medium text-ink-muted uppercase tracking-wide mb-1">
            {t("privateMode.stopHeading")}
          </p>
          <ul className="list-disc list-inside text-ink-muted space-y-0.5 mb-3">
            <li>{t("privateMode.stopProgress")}</li>
            <li>{t("privateMode.stopStats")}</li>
            <li>{t("privateMode.stopRecent")}</li>
            <li>{t("privateMode.stopActivity")}</li>
          </ul>

          <p className="text-[11px] font-medium text-ink-muted uppercase tracking-wide mb-1">
            {t("privateMode.continueHeading")}
          </p>
          <ul className="list-disc list-inside text-ink-muted space-y-0.5">
            <li>{t("privateMode.continueHighlights")}</li>
            <li>{t("privateMode.continueLibrary")}</li>
          </ul>

          <p className="text-[11px] text-ink-muted/60 mt-3 pt-2 border-t border-warm-border">
            {t("privateMode.restartNote")}
          </p>
        </div>
      )}
    </div>
  );
}
