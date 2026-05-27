import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOnboarding } from "../hooks/useOnboarding";
import { useImport } from "../context/ImportContext";
import { useFocusTrap } from "../lib/useFocusTrap";
import BookStackIllustration from "./BookStackIllustration";

interface OnboardingWizardProps {
  onImport: () => Promise<void>;
  onImportFolder: () => Promise<void>;
}

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1.5 justify-center mb-6">
      {([1, 2, 3] as const).map((step) => (
        <div
          key={step}
          className={`w-6 h-1 rounded-full transition-colors duration-200 ${
            step <= current ? "bg-accent" : "bg-warm-border"
          }`}
        />
      ))}
    </div>
  );
}

function WelcomeStep({ onAdvance, onSkip }: { onAdvance: () => void; onSkip: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="text-center">
      <div className="mb-6 flex justify-center">
        <BookStackIllustration />
      </div>
      <h2 id="onboarding-title" className="font-serif text-2xl font-semibold text-ink mb-2">
        {t("onboarding.welcome.title")}
      </h2>
      <p className="text-sm text-ink-muted leading-relaxed mb-8">
        {t("onboarding.welcome.subtitle")}
      </p>
      <button
        type="button"
        onClick={onAdvance}
        className="w-full px-5 py-3 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover focus:outline-2 focus:outline-accent focus:outline-offset-2 active:scale-[0.97] transition-all duration-150 shadow-sm"
      >
        {t("onboarding.welcome.cta")}
      </button>
      <p className="mt-4 text-xs text-ink-muted">
        <button type="button" onClick={onSkip} className="text-accent hover:text-accent-hover transition-colors">
          {t("onboarding.welcome.skip")}
        </button>
        {" — "}
        {t("onboarding.welcome.skipHint")}
      </p>
    </div>
  );
}

function ImportStep({
  onImport,
  onImportFolder,
  onSkip,
}: {
  onImport: () => Promise<void>;
  onImportFolder: () => Promise<void>;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="text-center">
      <div className="mb-6 flex justify-center">
        <div className="w-16 h-16 rounded-2xl bg-accent-light flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
      </div>
      <h2 id="onboarding-title" className="font-serif text-2xl font-semibold text-ink mb-2">
        {t("onboarding.import.title")}
      </h2>
      <p className="text-sm text-ink-muted leading-relaxed mb-6">
        {t("onboarding.import.subtitle")}
      </p>

      <div className="flex flex-col gap-2.5 mb-4">
        <button
          type="button"
          onClick={onImport}
          className="flex items-center gap-3 px-4 py-3.5 bg-warm-subtle rounded-xl text-left hover:bg-warm-border transition-colors"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink shrink-0">
            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          <div>
            <div className="text-sm font-medium text-ink">{t("onboarding.import.addFiles")}</div>
            <div className="text-xs text-ink-muted">{t("onboarding.import.addFilesHint")}</div>
          </div>
        </button>
        <button
          type="button"
          onClick={onImportFolder}
          className="flex items-center gap-3 px-4 py-3.5 bg-warm-subtle rounded-xl text-left hover:bg-warm-border transition-colors"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink shrink-0">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <div>
            <div className="text-sm font-medium text-ink">{t("onboarding.import.importFolder")}</div>
            <div className="text-xs text-ink-muted">{t("onboarding.import.importFolderHint")}</div>
          </div>
        </button>
      </div>

      <div className="border-2 border-dashed border-warm-border rounded-xl py-4 mb-4">
        <p className="text-xs text-ink-muted">{t("onboarding.import.dragDrop")}</p>
      </div>

      <button type="button" onClick={onSkip} className="text-xs text-accent hover:text-accent-hover transition-colors">
        {t("onboarding.welcome.skip")}
      </button>
    </div>
  );
}

function TipsStep({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation();

  const tips = [
    {
      icon: <span className="text-xs font-semibold text-accent">D</span>,
      title: t("onboarding.tips.focus"),
      desc: t("onboarding.tips.focusDesc"),
    },
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      ),
      title: t("onboarding.tips.catalogs"),
      desc: t("onboarding.tips.catalogsDesc"),
    },
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
      ),
      title: t("onboarding.tips.dragDrop"),
      desc: t("onboarding.tips.dragDropDesc"),
    },
  ];

  return (
    <div className="text-center">
      <div className="mb-6 flex justify-center">
        <div className="w-16 h-16 rounded-full bg-accent-light flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      </div>
      <h2 id="onboarding-title" className="font-serif text-2xl font-semibold text-ink mb-2">
        {t("onboarding.tips.title")}
      </h2>
      <p className="text-sm text-ink-muted leading-relaxed mb-6">
        {t("onboarding.tips.subtitle")}
      </p>

      <div className="flex flex-col gap-2.5 mb-8 text-left">
        {tips.map((tip) => (
          <div key={tip.title} className="flex items-start gap-3 px-3.5 py-3 bg-warm-subtle rounded-xl">
            <div className="w-8 h-8 rounded-lg bg-accent-light flex items-center justify-center shrink-0 mt-0.5">
              {tip.icon}
            </div>
            <div>
              <div className="text-sm font-medium text-ink">{tip.title}</div>
              <div className="text-xs text-ink-muted leading-relaxed">{tip.desc}</div>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onComplete}
        className="w-full px-5 py-3 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover focus:outline-2 focus:outline-accent focus:outline-offset-2 active:scale-[0.97] transition-all duration-150 shadow-sm"
      >
        {t("onboarding.tips.cta")}
      </button>
    </div>
  );
}

export default function OnboardingWizard({ onImport, onImportFolder }: OnboardingWizardProps) {
  const { isActive, currentStep, advance, skip, complete } = useOnboarding();
  const importCtx = useImport();
  const prevCompletedRef = useRef(importCtx.lastCompletedAt);
  const trapRef = useFocusTrap(skip);

  useEffect(() => {
    if (currentStep !== 2) return;
    if (
      importCtx.lastCompletedAt !== null &&
      importCtx.lastCompletedAt !== prevCompletedRef.current &&
      importCtx.progress?.phase !== "cancelled"
    ) {
      prevCompletedRef.current = importCtx.lastCompletedAt;
      advance();
    }
  }, [importCtx.lastCompletedAt, importCtx.progress?.phase, currentStep, advance]);

  if (!isActive) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className="relative bg-surface rounded-2xl shadow-2xl w-full max-w-[440px] mx-4 px-8 py-10 animate-[fade-in_0.2s_ease-out]"
      >
        <StepIndicator current={currentStep} />

        {currentStep === 1 && (
          <WelcomeStep onAdvance={advance} onSkip={skip} />
        )}
        {currentStep === 2 && (
          <ImportStep
            onImport={onImport}
            onImportFolder={onImportFolder}
            onSkip={skip}
          />
        )}
        {currentStep === 3 && (
          <TipsStep onComplete={complete} />
        )}
      </div>
    </div>
  );
}
