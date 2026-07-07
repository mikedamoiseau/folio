import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { friendlyError } from "../lib/errors";
import { useFocusTrap } from "../lib/useFocusTrap";

interface ProfileUnlockDialogProps {
  /** The locked profile this prompt unlocks. */
  profile: string;
  /** Called once the profile is accessible again — correct password, or a
   *  completed recovery reset. The caller retries whatever it was doing
   *  (a `switch_profile` call, or just letting the library render). */
  onUnlocked: () => void;
  /** Dismiss without unlocking. Omitted at startup, where there's no
   *  other profile to fall back to. */
  onCancel?: () => void;
}

/**
 * Blocking password prompt for a soft-locked profile (A-M3). Shown when
 * `switch_profile` — or the app-startup gate — reports `LockRequired`.
 *
 * Two views, swapped in place (mirrors `ProfileSwitcher`'s inline
 * create-profile view rather than stacking a second dialog):
 *  - the password form, with a pending state while `unlock_profile`'s
 *    argon2 verify runs in `spawn_blocking` (~200-500ms) so the button
 *    never looks frozen;
 *  - a "Can't sign in?" recovery step (Decision 9): a deliberate
 *    confirmation, not a one-tap button, whose copy states plainly that it
 *    clears the lock without the old password and never touches the
 *    library.
 */
export default function ProfileUnlockDialog({
  profile,
  onUnlocked,
  onCancel,
}: ProfileUnlockDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useFocusTrap(onCancel ?? (() => {}));
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      await invoke("unlock_profile", { profile, password });
      onUnlocked();
    } catch (err) {
      setError(friendlyError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    setError(null);
    try {
      await invoke("reset_profile_lock", { profile });
      onUnlocked();
    } catch (err) {
      setError(friendlyError(err, t));
      setRecovering(false);
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[90] animate-fade-in"
        onClick={onCancel}
      />
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("profiles.unlockTitle", { name: profile })}
          className="bg-surface rounded-2xl shadow-xl border border-warm-border w-full max-w-sm pointer-events-auto animate-slide-in-up overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {!recovering ? (
            <form onSubmit={handleUnlock} className="px-6 py-5 space-y-3">
              <h2 className="font-serif text-lg font-semibold text-ink leading-snug">
                {t("profiles.unlockTitle", { name: profile })}
              </h2>
              <div>
                <label htmlFor="profile-unlock-password" className="text-xs text-ink-muted mb-1 block">
                  {t("profiles.unlockPasswordLabel")}
                </label>
                <input
                  id="profile-unlock-password"
                  type="password"
                  value={password}
                  autoFocus
                  disabled={submitting}
                  onChange={(e) => { setPassword(e.target.value); setError(null); }}
                  placeholder={t("profiles.unlockPlaceholder")}
                  className="w-full bg-warm-subtle border border-warm-border rounded-lg px-2.5 py-1.5 text-sm text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                />
                {error && <p className="text-xs text-red-500 mt-1.5">{error}</p>}
              </div>
              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => { setRecovering(true); setError(null); }}
                  className="text-xs text-ink-muted hover:text-ink underline underline-offset-2 transition-colors"
                >
                  {t("profiles.cantSignIn")}
                </button>
                <div className="flex gap-2">
                  {onCancel && (
                    <button
                      type="button"
                      onClick={onCancel}
                      className="px-4 py-1.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-warm-subtle rounded-lg transition-colors duration-150"
                    >
                      {t("common.cancel")}
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={submitting || !password}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {submitting && (
                      <svg
                        className="w-3.5 h-3.5 animate-spin"
                        viewBox="0 0 24 24"
                        fill="none"
                        role="status"
                        aria-label={t("profiles.unlocking")}
                      >
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                      </svg>
                    )}
                    {submitting ? t("profiles.unlocking") : t("profiles.unlock")}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div className="px-6 py-5 space-y-3">
              <h2 className="font-serif text-lg font-semibold text-ink leading-snug">
                {t("profiles.recoveryTitle")}
              </h2>
              <p className="text-sm text-ink-muted leading-relaxed">
                {t("profiles.recoveryMessage")}
              </p>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => { setRecovering(false); setError(null); }}
                  className="px-4 py-1.5 text-sm font-medium text-ink-muted hover:text-ink hover:bg-warm-subtle rounded-lg transition-colors duration-150"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={resetting}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {resetting ? t("profiles.resetting") : t("profiles.recoveryConfirm")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
