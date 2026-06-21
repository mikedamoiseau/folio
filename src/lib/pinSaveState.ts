// Pure helpers for the web-server PIN save UX (UX audit F4b).
//
// The PIN is write-only: the backend never returns the stored PIN, only
// whether one exists. So "unsaved" means the user has typed a non-empty PIN
// in this session that differs from the last value persisted via
// `web_server_set_pin`. `savedPin` holds that last-persisted value — it is
// distinct from the transient "PIN saved ✓" success indicator, which clears
// after a couple of seconds and must NOT drive the dirty/persisted decision.

/** True when the typed PIN differs from the last persisted PIN (and so would be lost on close). */
export function isPinUnsaved(pin: string, savedPin: string): boolean {
  return pin.length > 0 && pin !== savedPin;
}

/**
 * True when a save-on-blur should actually fire. Only fires for an unsaved,
 * non-empty, valid PIN — never auto-submits a partial/invalid PIN, preserving
 * the existing validation that gates remote access. Compares against the
 * last-persisted PIN so a just-saved PIN is not re-submitted on the next blur.
 */
export function shouldSaveOnBlur(pin: string, savedPin: string, isValid: boolean): boolean {
  return isPinUnsaved(pin, savedPin) && isValid;
}
