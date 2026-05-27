import { useTranslation } from "react-i18next";

interface WhatsNewBannerProps {
  version: string;
  summary: string;
  onClickCta: () => void;
  onDismiss: () => void;
}

export default function WhatsNewBanner({ version, summary, onClickCta, onDismiss }: WhatsNewBannerProps) {
  const { t } = useTranslation();

  return (
    <div className="mx-6 mt-3 px-4 py-2.5 bg-gradient-to-r from-accent to-accent-hover text-white text-sm rounded-xl flex items-center gap-3">
      <span className="flex-1">
        <span className="font-semibold">{t("whatsNew.bannerTitle", { version })}</span>
        {" — "}
        <span className="opacity-90">{t("whatsNew.bannerSummary", { title: summary })}</span>
      </span>
      <button
        type="button"
        onClick={onClickCta}
        className="shrink-0 font-medium hover:underline transition-colors"
      >
        {t("whatsNew.bannerCta")} →
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-1 rounded opacity-80 hover:opacity-100 transition-opacity"
        aria-label={t("reader.dismiss")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
