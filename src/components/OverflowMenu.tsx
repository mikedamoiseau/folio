import { useEffect, useRef, useState, type ReactNode } from "react";

interface OverflowMenuProps {
  /** Accessible label for the trigger button. */
  label: string;
  /** Menu items (usually buttons). Clicking inside closes the menu. */
  children: ReactNode;
}

/**
 * A compact "⋯" overflow menu for secondary header actions. Keeps the reader
 * header from sprawling into a flat row of 15+ icons by tucking low-frequency
 * controls behind one trigger. Closes on outside click, Escape, or item click.
 */
export default function OverflowMenu({ label, children }: OverflowMenuProps) {
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

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`p-1.5 transition-colors rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${open ? "text-accent bg-accent-light" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"}`}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
          <circle cx="4" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="16" cy="10" r="1.6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          // Clicking any item closes the menu (the action runs first via the
          // child's own onClick, then this bubbles up).
          onClick={() => setOpen(false)}
          className="absolute right-0 top-full mt-1 min-w-44 bg-surface border border-warm-border rounded-xl shadow-lg z-50 py-1 animate-fade-in flex flex-col"
        >
          {children}
        </div>
      )}
    </div>
  );
}
