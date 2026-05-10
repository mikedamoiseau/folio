import { useTranslation } from "react-i18next";
import { useImport } from "../context/ImportContext";

export default function ImportStatusBar() {
  const { progress, running, cancel } = useImport();
  const { t } = useTranslation();

  if (!progress) return null;

  const { phase, current, total, filename, imported, errors } = progress;

  let primary: string;
  if (phase === "scanning") {
    primary = t("library.scanningFolder", { folder: filename, count: current });
  } else if (phase === "importing") {
    primary = total > 0
      ? t("library.importingProgress", { current, total })
      : t("library.importing");
  } else if (phase === "cancelled") {
    primary = t("library.importBackgroundCancelled", { imported, errors });
  } else if (phase === "done") {
    primary = t("library.importBackgroundDone", { imported, errors });
  } else {
    primary = "";
  }

  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  const showCancel = running && phase !== "cancelled" && phase !== "done";

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
          {(phase === "importing" || phase === "scanning") && (imported > 0 || errors > 0) && (
            <div className="text-xs text-ink-muted mt-0.5">
              {imported > 0 && (
                <span>{t("library.imported", { count: imported })}</span>
              )}
              {imported > 0 && errors > 0 && <span> · </span>}
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
      </div>
    </div>
  );
}
