import { useTranslation } from "react-i18next";
import BookStackIllustration from "./BookStackIllustration";

interface EmptyStateProps {
  onImport: () => void;
  onImportFolder: () => void;
  onBrowseCatalogs?: () => void;
}

export default function EmptyState({ onImport, onImportFolder, onBrowseCatalogs }: EmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full max-w-xs mx-auto text-center gap-0">
      <div className="mb-8">
        <BookStackIllustration />
      </div>

      <h2 className="font-serif text-2xl font-semibold text-ink mb-2" style={{ animation: "fade-in 0.3s ease 0.55s both" }}>
        {t("empty.title")}
      </h2>
      <p className="text-sm text-ink-muted mb-7 leading-relaxed" style={{ animation: "fade-in 0.3s ease 0.65s both" }}>
        {t("empty.subtitle")}
      </p>

      <div className="flex items-center gap-3" style={{ animation: "fade-in 0.3s ease 0.75s both" }}>
        <button
          type="button"
          onClick={onImport}
          className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover focus:outline-2 focus:outline-accent focus:outline-offset-2 active:scale-[0.97] transition-all duration-150 shadow-sm"
        >
          {t("empty.addBooks")}
        </button>
        <button
          type="button"
          onClick={onImportFolder}
          className="px-5 py-2.5 text-sm font-medium text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors"
        >
          {t("empty.importFolder")}
        </button>
      </div>

      {onBrowseCatalogs && (
        <button
          type="button"
          onClick={onBrowseCatalogs}
          className="mt-4 text-sm text-accent hover:text-accent-hover transition-colors"
        >
          {t("empty.browseCatalogs")}
        </button>
      )}

      <p className="mt-4 text-xs text-ink-muted">
        {t("empty.dragAndDrop")}
      </p>
    </div>
  );
}
