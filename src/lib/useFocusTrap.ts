import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Trap keyboard focus within a dialog element. Handles:
 * - Tab / Shift+Tab cycling within the dialog
 * - Escape key to call onClose
 * - Auto-focus the first focusable element on mount
 *
 * `enabled` (default `true`) lets a caller suspend the trap — e.g. a panel
 * that hosts a nested modal should disable its own trap while the nested
 * modal is open, so a single Escape only closes the topmost one instead of
 * both (document-level keydown listeners don't respect stopPropagation
 * across separate useFocusTrap instances).
 */
export function useFocusTrap(
  onClose: () => void,
  enabled = true,
  focusContainer = false,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
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
    // Move focus into the dialog on mount. Default: the first focusable
    // element (good for forms — lands on the first input). `focusContainer`
    // instead focuses the dialog itself, so no action button shows a focus
    // ring on open — used where auto-highlighting a button is undesirable
    // (e.g. an opt-in prompt) and reliable across engines whose
    // `:focus-visible` matches programmatic focus (WebKit).
    if (focusContainer) {
      el.setAttribute("tabindex", "-1");
      el.focus();
    } else {
      const first = el.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, enabled, focusContainer]);

  return ref;
}
