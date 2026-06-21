import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useOnboardingContext } from "../context/OnboardingContext";
import { useImport } from "../context/ImportContext";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../context/ThemeContext";
import { FONT_OPTIONS, type ColorMode } from "../lib/themes";
import { LANGUAGES } from "../i18n";
import BookStackIllustration from "./BookStackIllustration";

interface OnboardingWizardProps {
  onImport: () => Promise<void>;
  onImportFolder: () => Promise<void>;
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-1.5 justify-center mb-6">
      {Array.from({ length: total }, (_, i) => i + 1).map((step) => (
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
  status,
  onRetry,
  onProceed,
}: {
  onImport: () => Promise<void>;
  onImportFolder: () => Promise<void>;
  onSkip: () => void;
  status: "empty" | "error" | "cancelled" | null;
  onRetry: () => void;
  onProceed: () => void;
}) {
  const { t } = useTranslation();
  const bannerMessageKey =
    status === "empty"
      ? "onboarding.import.emptyBanner"
      : status === "error"
        ? "onboarding.import.errorBanner"
        : status === "cancelled"
          ? "onboarding.import.cancelledBanner"
          : null;
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

      {bannerMessageKey && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-left"
        >
          <p className="text-sm text-red-700 dark:text-red-300">{t(bannerMessageKey)}</p>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1.5 bg-accent text-white text-xs font-medium rounded-lg hover:bg-accent-hover transition-colors duration-150"
            >
              {t("onboarding.import.retry")}
            </button>
            <button
              type="button"
              onClick={onProceed}
              className="px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors duration-150"
            >
              {t("onboarding.import.continueAnyway")}
            </button>
          </div>
        </div>
      )}

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

const THEME_CHOICES: { mode: ColorMode; labelKey: string }[] = [
  { mode: "light", labelKey: "onboarding.preferences.themeLight" },
  { mode: "dark", labelKey: "onboarding.preferences.themeDark" },
  { mode: "system", labelKey: "onboarding.preferences.themeSystem" },
  { mode: "sepia", labelKey: "onboarding.preferences.themeSepia" },
];

function PreferencesStep({ onContinue }: { onContinue: () => void }) {
  const { t, i18n } = useTranslation();
  const { mode, setMode, fontFamily, setFontFamily, fontSize, setFontSize } = useTheme();
  const [importMode, setImportMode] = useState<"import" | "link">("import");

  useEffect(() => {
    invoke<string | null>("get_setting_value", { key: "import_mode" })
      .then((v) => {
        if (v === "import" || v === "link") setImportMode(v);
      })
      .catch(() => {});
  }, []);

  const changeImportMode = async (next: "import" | "link") => {
    setImportMode(next);
    await invoke("set_setting_value", { key: "import_mode", value: next });
  };

  return (
    <div className="text-center">
      <h2 id="onboarding-title" className="font-serif text-2xl font-semibold text-ink mb-2">
        {t("onboarding.preferences.title")}
      </h2>
      <p className="text-sm text-ink-muted leading-relaxed mb-6">
        {t("onboarding.preferences.subtitle")}
      </p>

      <div className="flex flex-col gap-5 text-left mb-8">
        {/* Language */}
        <div>
          <label className="text-xs font-medium text-ink-muted mb-2 block">
            {t("onboarding.preferences.language")}
          </label>
          <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
            {LANGUAGES.map((lang) => (
              <button
                type="button"
                key={lang.code}
                onClick={() => i18n.changeLanguage(lang.code)}
                className={`flex-1 px-3 py-2 text-sm rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 ${
                  i18n.language === lang.code
                    ? "bg-surface text-ink shadow-sm font-medium"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                <span>{lang.flag}</span>
                <span>{lang.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Theme */}
        <div>
          <label className="text-xs font-medium text-ink-muted mb-2 block">
            {t("onboarding.preferences.theme")}
          </label>
          <div className="grid grid-cols-4 gap-1 bg-warm-subtle rounded-xl p-1">
            {THEME_CHOICES.map((choice) => (
              <button
                type="button"
                key={choice.mode}
                onClick={() => setMode(choice.mode)}
                className={`px-2 py-2 text-sm rounded-lg transition-all duration-150 ${
                  mode === choice.mode
                    ? "bg-surface text-ink shadow-sm font-medium"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                {t(choice.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Font family */}
        <div>
          <label className="text-xs font-medium text-ink-muted mb-2 block">
            {t("onboarding.preferences.font")}
          </label>
          <div className="flex flex-col gap-1">
            {FONT_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.key}
                onClick={() => setFontFamily(option.key)}
                className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-all duration-150 ${
                  fontFamily === option.key
                    ? "bg-accent-light text-accent font-medium"
                    : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
                }`}
                style={{ fontFamily: option.css }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* Font size */}
        <div>
          <label className="text-xs font-medium text-ink-muted mb-2 block">
            {t("onboarding.preferences.fontSize")}
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= MIN_FONT_SIZE}
              className="w-9 h-9 rounded-lg bg-warm-subtle text-ink disabled:opacity-40 hover:bg-warm-border transition-colors"
              aria-label="Decrease font size"
            >
              −
            </button>
            <span className="flex-1 text-center text-sm text-ink">{fontSize}px</span>
            <button
              type="button"
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= MAX_FONT_SIZE}
              className="w-9 h-9 rounded-lg bg-warm-subtle text-ink disabled:opacity-40 hover:bg-warm-border transition-colors"
              aria-label="Increase font size"
            >
              +
            </button>
          </div>
        </div>

        {/* Import mode */}
        <div>
          <label className="text-xs font-medium text-ink-muted mb-2 block">
            {t("onboarding.preferences.importMode")}
          </label>
          <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
            {(["import", "link"] as const).map((option) => (
              <button
                type="button"
                key={option}
                onClick={() => changeImportMode(option)}
                className={`flex-1 px-3 py-2 text-sm rounded-lg transition-all duration-150 ${
                  importMode === option
                    ? "bg-surface text-ink shadow-sm font-medium"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                {option === "import"
                  ? t("onboarding.preferences.importModeCopy")
                  : t("onboarding.preferences.importModeLink")}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-muted mt-2">
            {t("onboarding.preferences.importModeHelp")}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="w-full px-5 py-3 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover focus:outline-2 focus:outline-accent focus:outline-offset-2 active:scale-[0.97] transition-all duration-150 shadow-sm"
      >
        {t("onboarding.preferences.cta")}
      </button>
    </div>
  );
}

export default function OnboardingWizard({ onImport, onImportFolder }: OnboardingWizardProps) {
  const { isActive, currentStep, advance, skip, complete } = useOnboardingContext();
  const importCtx = useImport();
  const prevCompletedRef = useRef(importCtx.lastCompletedAt);
  const trapRef = useFocusTrap(skip);

  // A finished import that yielded nothing to advance on — surface a banner so
  // step 3 isn't silently stuck. This is held in LOCAL state rather than read
  // live from `importCtx.progress`, because the ImportProvider clears
  // `progress` 4s after an `empty`/`cancelled` phase. Reading it live would let
  // the banner vanish (returning to a silent stuck step) if the user doesn't
  // act in time. Capturing the terminal phase here makes it survive that clear.
  const [importStatus, setImportStatus] = useState<"empty" | "error" | "cancelled" | null>(null);

  const phase = importCtx.progress?.phase;
  useEffect(() => {
    if (phase === "empty" || phase === "error" || phase === "cancelled") {
      setImportStatus(phase);
    } else if (phase === "scanning" || phase === "importing") {
      // A new import is under way — drop any stale terminal banner.
      setImportStatus(null);
    }
  }, [phase]);

  useEffect(() => {
    if (currentStep !== 3) return;
    if (
      importCtx.lastCompletedAt !== null &&
      importCtx.lastCompletedAt !== prevCompletedRef.current &&
      // Guard against a stuck terminal status slipping through to advance. The
      // ImportProvider bumps `lastCompletedAt` for the `cancelled` phase too
      // (only `empty`/`error` are excluded), so without this guard a cancel
      // would auto-advance. We check both the captured local status and the
      // live phase: the local status survives the 4s `progress` clear, while
      // the live phase covers the commit where the terminal phase and the
      // `lastCompletedAt` bump land together (before the status effect has
      // run). Only the happy `done` path advances.
      importStatus === null &&
      phase !== "cancelled" &&
      phase !== "empty" &&
      phase !== "error"
    ) {
      prevCompletedRef.current = importCtx.lastCompletedAt;
      advance();
    }
  }, [importCtx.lastCompletedAt, importStatus, phase, currentStep, advance]);

  const handleRetry = () => {
    setImportStatus(null);
    if (importCtx.canRetry) {
      void importCtx.retry();
    } else {
      void onImportFolder();
    }
  };

  const handleProceed = () => {
    setImportStatus(null);
    advance();
  };

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
        <StepIndicator current={currentStep} total={4} />

        {currentStep === 1 && (
          <WelcomeStep onAdvance={advance} onSkip={skip} />
        )}
        {currentStep === 2 && (
          <PreferencesStep onContinue={advance} />
        )}
        {currentStep === 3 && (
          <ImportStep
            onImport={onImport}
            onImportFolder={onImportFolder}
            onSkip={skip}
            status={importStatus}
            onRetry={handleRetry}
            onProceed={handleProceed}
          />
        )}
        {currentStep === 4 && (
          <TipsStep onComplete={complete} />
        )}
      </div>
    </div>
  );
}
