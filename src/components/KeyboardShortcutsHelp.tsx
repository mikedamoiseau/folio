interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string; description: string }[];
}

const LIBRARY_SHORTCUTS: ShortcutGroup = {
  title: "Library",
  shortcuts: [
    { keys: "/", description: "Focus search" },
    { keys: "Escape", description: "Clear search / close panels" },
    { keys: "c", description: "Toggle collections sidebar" },
    { keys: "?", description: "Toggle this help" },
  ],
};

const READER_SHORTCUTS: ShortcutGroup = {
  title: "Reader",
  shortcuts: [
    { keys: "\u2190 / \u2192", description: "Previous / Next chapter" },
    { keys: "t", description: "Toggle table of contents" },
    { keys: "b", description: "Add bookmark" },
    { keys: "d", description: "Toggle focus mode" },
    { keys: "Escape", description: "Close panels / Exit focus / Back to library" },
    { keys: "?", description: "Toggle this help" },
  ],
};

interface KeyboardShortcutsHelpProps {
  context: "library" | "reader";
  onClose: () => void;
}

export default function KeyboardShortcutsHelp({ context, onClose }: KeyboardShortcutsHelpProps) {
  const groups = context === "library"
    ? [LIBRARY_SHORTCUTS, READER_SHORTCUTS]
    : [READER_SHORTCUTS, LIBRARY_SHORTCUTS];

  return (
    <>
      <div className="fixed inset-0 bg-ink/30 z-50 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-md pointer-events-auto animate-fade-in max-h-[80vh] overflow-y-auto">
          <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
            <h2 className="font-serif text-base font-semibold text-ink">Keyboard Shortcuts</h2>
            <button
              onClick={onClose}
              className="p-1 text-ink-muted hover:text-ink transition-colors rounded"
              aria-label="Close"
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
