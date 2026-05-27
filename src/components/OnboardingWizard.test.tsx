import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import OnboardingWizard from "./OnboardingWizard";
import { STORAGE_KEY } from "../hooks/useOnboarding";

// Mock react-i18next — return the key as the translated string
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../lib/useFocusTrap", () => ({
  useFocusTrap: () => ({ current: null }),
}));

vi.mock("../context/ImportContext", () => ({
  useImport: () => ({
    running: false,
    progress: null,
    lastCompletedAt: null,
    startFolder: async () => {},
    startFiles: async () => {},
    cancel: async () => {},
  }),
}));

describe("OnboardingWizard", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const noop = async () => {};

  it("renders Step 1 (welcome) on first mount", () => {
    const html = renderToString(
      <OnboardingWizard onImport={noop} onImportFolder={noop} />
    );
    expect(html).toContain("onboarding.welcome.title");
    expect(html).toContain("onboarding.welcome.cta");
  });

  it("renders the backdrop overlay", () => {
    const html = renderToString(
      <OnboardingWizard onImport={noop} onImportFolder={noop} />
    );
    expect(html).toContain("fixed");
    expect(html).toContain("inset-0");
  });

  it("renders step indicator dots", () => {
    const html = renderToString(
      <OnboardingWizard onImport={noop} onImportFolder={noop} />
    );
    expect(html).toContain("bg-accent");
    expect(html).toContain("bg-warm-border");
  });

  it("renders skip link on Step 1", () => {
    const html = renderToString(
      <OnboardingWizard onImport={noop} onImportFolder={noop} />
    );
    expect(html).toContain("onboarding.welcome.skip");
  });

  it("renders with dialog a11y attributes", () => {
    const html = renderToString(
      <OnboardingWizard onImport={noop} onImportFolder={noop} />
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="onboarding-title"');
    expect(html).toContain('id="onboarding-title"');
  });

  it("does not render when onboarding already completed", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const html = renderToString(
      <OnboardingWizard onImport={noop} onImportFolder={noop} />
    );
    expect(html).toBe("");
  });
});
