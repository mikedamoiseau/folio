import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Trap keyboard focus within a dialog element. Handles:
 * - Tab / Shift+Tab cycling within the dialog
 * - Escape key to call onClose
 * - Auto-focus the first focusable element on mount
 */
export function useFocusTrap(
  onClose: () => void,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const focusable = el.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    // Auto-focus first focusable element
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return ref;
}
