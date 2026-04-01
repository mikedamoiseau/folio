import { useTranslation } from "react-i18next";

interface EmptyStateProps {
  onImport: () => void;
  onImportFolder: () => void;
  onBrowseCatalogs?: () => void;
}

export default function EmptyState({ onImport, onImportFolder, onBrowseCatalogs }: EmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full max-w-xs mx-auto text-center gap-0">
      {/* Book stack illustration */}
      <div className="mb-8 relative w-28 h-28 flex items-end justify-center">
        {/* Back book */}
        <div className="absolute bottom-0 left-3 w-16 h-20 rounded-sm bg-warm-subtle border border-warm-border shadow-sm rotate-[-8deg] origin-bottom" />
        {/* Middle book */}
        <div className="absolute bottom-0 left-6 w-16 h-[72px] rounded-sm bg-warm-border shadow-sm rotate-[3deg] origin-bottom" />
        {/* Front book */}
        <div className="relative w-16 h-[84px] rounded-sm bg-accent-light border border-accent/30 shadow-md flex flex-col items-center justify-center gap-2">
          <div className="w-8 h-px bg-accent/40 rounded" />
          <div className="w-6 h-px bg-accent/30 rounded" />
          <div className="w-8 h-px bg-accent/40 rounded" />
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            className="text-accent mt-1"
          >
            <path
              d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      <h2 className="font-serif text-2xl font-semibold text-ink mb-2">
        {t("empty.title")}
      </h2>
      <p className="text-sm text-ink-muted mb-7 leading-relaxed">
        {t("empty.subtitle")}
      </p>

      <div className="flex items-center gap-3">
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
