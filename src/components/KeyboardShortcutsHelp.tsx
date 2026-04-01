import { useTranslation } from "react-i18next";

interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string; description: string }[];
}

interface KeyboardShortcutsHelpProps {
  context: "library" | "reader";
  onClose: () => void;
}

export default function KeyboardShortcutsHelp({ context, onClose }: KeyboardShortcutsHelpProps) {
  const { t } = useTranslation();

  const libraryShortcuts: ShortcutGroup = {
    title: t("shortcuts.libraryGroup"),
    shortcuts: [
      { keys: "/", description: t("shortcuts.focusSearch") },
      { keys: "Escape", description: t("shortcuts.clearClose") },
      { keys: "c", description: t("shortcuts.toggleCollections") },
      { keys: "?", description: t("shortcuts.toggleHelp") },
    ],
  };

  const readerShortcuts: ShortcutGroup = {
    title: t("shortcuts.readerGroup"),
    shortcuts: [
      { keys: "\u2190 / \u2192", description: t("shortcuts.prevNextChapter") },
      { keys: "\u2190 / \u2192", description: t("shortcuts.prevNextPage") },
      { keys: "+ / \u2212", description: t("shortcuts.zoomInOut") },
      { keys: "0", description: t("shortcuts.resetZoom") },
      { keys: "t", description: t("shortcuts.toggleToc") },
      { keys: "b", description: t("shortcuts.addBookmark") },
      { keys: "d", description: t("shortcuts.toggleFocus") },
      { keys: "Escape", description: t("shortcuts.closeExit") },
      { keys: "?", description: t("shortcuts.toggleHelp") },
    ],
  };

  const groups = context === "library"
    ? [libraryShortcuts, readerShortcuts]
    : [readerShortcuts, libraryShortcuts];

  return (
    <>
      <div className="fixed inset-0 bg-ink/30 z-50 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-md pointer-events-auto animate-fade-in max-h-[80vh] overflow-y-auto">
          <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
            <h2 className="font-serif text-base font-semibold text-ink">{t("shortcuts.title")}</h2>
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
          <div className="px-5 py-4 space-y-5">
            {groups.map((group) => (
              <div key={group.title}>
                <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">{group.title}</h3>
                <div className="space-y-1.5">
                  {group.shortcuts.map((s) => (
                    <div key={s.keys} className="flex items-center justify-between">
                      <span className="text-sm text-ink">{s.description}</span>
                      <kbd className="px-2 py-0.5 text-xs font-mono bg-warm-subtle border border-warm-border rounded text-ink-muted">
                        {s.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
