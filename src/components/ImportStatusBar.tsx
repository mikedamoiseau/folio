import { useTranslation } from "react-i18next";
import { useImport } from "../context/ImportContext";
import { friendlyError } from "../lib/errors";

export default function ImportStatusBar() {
  const { progress, running, cancel, retry, dismiss } = useImport();
  const { t } = useTranslation();

  if (!progress) return null;

  const { phase, current, total, filename, imported, duplicates, errors } = progress;

  let primary: string;
  if (phase === "scanning") {
    primary = t("library.scanningFolder", { folder: filename, count: current });
  } else if (phase === "importing") {
    primary = total > 0
      ? t("library.importingProgress", { current, total })
      : t("library.importing");
  } else if (phase === "cancelled") {
    primary = t("library.importBackgroundCancelled", { imported, duplicates, errors });
  } else if (phase === "done") {
    primary = t("library.importBackgroundDone", { imported, duplicates, errors });
  } else if (phase === "empty") {
    primary = t("library.noSupportedFiles");
  } else if (phase === "error") {
    // Backend stuffs the error string into `filename` for the error phase
    // (the event shape has no dedicated message field). Translate the raw
    // backend string into friendly copy instead of surfacing "IO: ...".
    primary = t("library.importBackgroundError", { error: friendlyError(filename, t) });
  } else {
    primary = "";
  }

  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  const showCancel =
    running &&
    phase !== "cancelled" &&
    phase !== "done" &&
    phase !== "empty" &&
    phase !== "error";

  return (
    <div
      className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-warm-border bg-surface shadow-lg overflow-hidden"
      role="status"
      aria-live="polite"
    >
      {phase === "importing" && total > 0 && (
        <div className="h-1 bg-warm-subtle">
          <div
            className="h-full bg-accent transition-all duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <div className="p-3 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-ink truncate" title={primary}>
            {primary}
          </div>
          {phase === "importing" && filename && (
            <div className="text-xs text-ink-muted truncate mt-0.5" title={filename}>
              {t("library.importingFile", { filename })}
            </div>
          )}
          {(phase === "importing" || phase === "scanning") &&
            (imported > 0 || duplicates > 0 || errors > 0) && (
              <div className="text-xs text-ink-muted mt-0.5">
                {imported > 0 && (
                  <span>{t("library.imported", { count: imported })}</span>
                )}
                {imported > 0 && (duplicates > 0 || errors > 0) && <span> · </span>}
                {duplicates > 0 && (
                  <span>{t("library.skipped", { count: duplicates })}</span>
                )}
                {duplicates > 0 && errors > 0 && <span> · </span>}
                {errors > 0 && (
                  <span>{t("library.failed", { count: errors })}</span>
                )}
              </div>
            )}
        </div>
        {showCancel && (
          <button
            onClick={() => {
              void cancel();
            }}
            className="shrink-0 text-xs px-2 py-1 rounded border border-warm-border text-ink-muted hover:text-ink hover:bg-warm-subtle"
          >
            {t("common.cancel")}
          </button>
        )}
        {phase === "error" && (
          <div className="shrink-0 flex items-center gap-1.5">
            <button
              onClick={() => {
                void retry();
              }}
              className="text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover"
            >
              {t("library.retryImport")}
            </button>
            <button
              onClick={dismiss}
              className="text-xs px-2 py-1 rounded border border-warm-border text-ink-muted hover:text-ink hover:bg-warm-subtle"
              aria-label={t("common.close")}
            >
              {t("common.close")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
