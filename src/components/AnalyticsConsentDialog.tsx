import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "./ConfirmDialog";

/**
 * First-run analytics opt-in. Reads app-global consent on mount; renders the
 * dialog only while consent is "unset" (self-gating tri-state). "Enable" ⇒
 * enabled; "Not now" ⇒ disabled. Dismissing (Escape / backdrop click) routes
 * through ConfirmDialog's onCancel, i.e. it is treated as "Not now" ⇒ disabled
 * — so once shown, the dialog resolves consent one way or the other and does
 * not reappear. Fail-closed throughout: nothing is tracked unless "Enable".
 */
export default function AnalyticsConsentDialog() {
  const { t } = useTranslation();
  const [needsChoice, setNeedsChoice] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const consent = await invoke<string>("get_analytics_consent");
        if (!cancelled && consent === "unset") setNeedsChoice(true);
      } catch {
        // fail-closed: if we can't read consent, don't prompt and don't track
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!needsChoice) return null;

  const choose = async (consent: "enabled" | "disabled") => {
    try {
      await invoke("set_analytics_consent", { consent });
    } finally {
      setNeedsChoice(false);
    }
  };

  return (
    <ConfirmDialog
      title={t("settings.analyticsTitle")}
      message={t("settings.analyticsMessage")}
      confirmLabel={t("settings.analyticsEnable")}
      cancelLabel={t("settings.analyticsNotNow")}
      destructive={false}
      autoFocus="dialog"
      onConfirm={() => void choose("enabled")}
      onCancel={() => void choose("disabled")}
    />
  );
}
