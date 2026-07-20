import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Controlled "want to read" bookmark toggle. The parent owns the value; on
 * click this awaits the `set_want_to_read` IPC command and only calls
 * `onChange(next)` after the write commits — there is no optimistic flip, so a
 * concurrent reload can't clobber an in-flight change. While a write is pending
 * the button is marked `aria-disabled` and an in-handler guard drops overlapping
 * clicks — we avoid the native `disabled` attribute so the button stays
 * focusable and in tab order (native disable blurs focus to the body and never
 * restores it). On failure it calls `onError` and leaves the flag unchanged.
 */
export default function WantToReadToggle({
  bookId,
  value,
  onChange,
  onError,
}: {
  bookId: string;
  value: boolean;
  onChange: (next: boolean) => void;
  onError?: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const toggle = async (e: React.MouseEvent) => {
    // The toggle is nested inside clickable cards; keep the click local.
    e.stopPropagation();
    // In-handler guard (replaces the native `disabled` attribute) so a click
    // while a write is in flight can't fire a second overlapping IPC call.
    if (pending) return;
    const next = !value;
    setPending(true);
    try {
      await invoke("set_want_to_read", { bookId, want: next });
      onChange(next);
    } catch (err) {
      onError?.(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      aria-pressed={value}
      aria-label={t("library.wantToRead")}
      title={t("library.wantToRead")}
      onClick={toggle}
      aria-disabled={pending}
      className={`shrink-0 ${value ? "text-accent" : "text-ink-muted"} ${pending ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill={value ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
