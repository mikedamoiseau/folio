// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import OnboardingWizard from "./OnboardingWizard";
import { OnboardingProvider } from "../context/OnboardingContext";
import { STORAGE_KEY } from "../hooks/useOnboarding";

const mockChangeLanguage = vi.fn();
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: mockChangeLanguage },
  }),
}));

vi.mock("../lib/useFocusTrap", () => ({
  useFocusTrap: () => ({ current: null }),
}));

vi.mock("../i18n", () => ({
  LANGUAGES: [
    { code: "en", flag: "🇬🇧", label: "English" },
    { code: "fr", flag: "🇫🇷", label: "Français" },
  ],
}));

const mockSetMode = vi.fn();
const mockSetFontFamily = vi.fn();
const mockSetFontSize = vi.fn();
vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    mode: "light",
    setMode: mockSetMode,
    fontFamily: "serif",
    setFontFamily: mockSetFontFamily,
    fontSize: 18,
    setFontSize: mockSetFontSize,
  }),
  MIN_FONT_SIZE: 14,
  MAX_FONT_SIZE: 24,
}));

const mockInvoke = vi.fn(async (..._args: unknown[]) => null);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

let mockLastCompletedAt: number | null = null;
let mockPhase: string | null = null;

vi.mock("../context/ImportContext", () => ({
  useImport: () => ({
    running: false,
    progress: mockPhase ? { phase: mockPhase } : null,
    lastCompletedAt: mockLastCompletedAt,
    startFolder: async () => {},
    startFiles: async () => {},
    cancel: async () => {},
  }),
}));

describe("OnboardingWizard", () => {
  beforeEach(() => {
    localStorage.clear();
    mockLastCompletedAt = null;
    mockPhase = null;
    mockChangeLanguage.mockClear();
    mockSetMode.mockClear();
    mockSetFontFamily.mockClear();
    mockSetFontSize.mockClear();
    mockInvoke.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  const noop = async () => {};
  const props = { onImport: noop, onImportFolder: noop };

  const renderWizard = (p = props) =>
    render(
      <OnboardingProvider>
        <OnboardingWizard {...p} />
      </OnboardingProvider>
    );

  // --- Rendering ---

  it("renders Step 1 on first mount", () => {
    renderWizard();
    expect(screen.getByText("onboarding.welcome.title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.welcome.cta")).toBeInTheDocument();
    expect(screen.getByText("onboarding.welcome.subtitle")).toBeInTheDocument();
  });

  it("does not render when onboarding already completed", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { container } = renderWizard();
    expect(container.innerHTML).toBe("");
  });

  it("has dialog a11y attributes", () => {
    renderWizard();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "onboarding-title");
    expect(screen.getByText("onboarding.welcome.title")).toHaveAttribute("id", "onboarding-title");
  });

  it("renders step indicator with 1 active and 3 inactive dots", () => {
    renderWizard();
    const dots = screen.getByRole("dialog").querySelectorAll(".rounded-full");
    expect(dots).toHaveLength(4);
    expect(dots[0].className).toContain("bg-accent");
    expect(dots[1].className).toContain("bg-warm-border");
    expect(dots[2].className).toContain("bg-warm-border");
    expect(dots[3].className).toContain("bg-warm-border");
  });

  // --- Step 1 → Step 2 (Preferences) ---

  it("advances to Preferences when CTA clicked", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));

    expect(screen.getByText("onboarding.preferences.title")).toBeInTheDocument();
    expect(screen.queryByText("onboarding.welcome.title")).not.toBeInTheDocument();
  });

  // --- Preferences (Step 2) ---

  it("renders all preference controls on Step 2", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    expect(screen.getByText("onboarding.preferences.title")).toBeInTheDocument();
    expect(screen.getByText("English")).toBeInTheDocument();
    expect(screen.getByText("Français")).toBeInTheDocument();
    expect(screen.getByText("Lora")).toBeInTheDocument();
    expect(screen.getByText("onboarding.preferences.themeDark")).toBeInTheDocument();
  });

  it("changes language when a language button is clicked", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("Français"));
    expect(mockChangeLanguage).toHaveBeenCalledWith("fr");
  });

  it("sets theme mode when a theme button is clicked", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.themeDark"));
    expect(mockSetMode).toHaveBeenCalledWith("dark");
  });

  it("sets font family when a font button is clicked", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("Literata"));
    expect(mockSetFontFamily).toHaveBeenCalledWith("literata");
  });

  it("writes import_mode when an import-mode button is clicked", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.importModeLink"));
    expect(mockInvoke).toHaveBeenCalledWith("set_setting_value", { key: "import_mode", value: "link" });
  });

  it("advances from Preferences to Import on Continue", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));
    expect(screen.getByText("onboarding.import.title")).toBeInTheDocument();
  });

  // --- Import (Step 3) ---

  it("shows import options on Step 3", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));

    expect(screen.getByText("onboarding.import.addFiles")).toBeInTheDocument();
    expect(screen.getByText("onboarding.import.addFilesHint")).toBeInTheDocument();
    expect(screen.getByText("onboarding.import.importFolder")).toBeInTheDocument();
    expect(screen.getByText("onboarding.import.importFolderHint")).toBeInTheDocument();
    expect(screen.getByText("onboarding.import.dragDrop")).toBeInTheDocument();
  });

  it("calls onImport when Add Files clicked", () => {
    const onImport = vi.fn(async () => {});
    renderWizard({ onImport, onImportFolder: noop });
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));
    fireEvent.click(screen.getByText("onboarding.import.addFiles"));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("calls onImportFolder when Import Folder clicked", () => {
    const onImportFolder = vi.fn(async () => {});
    renderWizard({ onImport: noop, onImportFolder });
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));
    fireEvent.click(screen.getByText("onboarding.import.importFolder"));
    expect(onImportFolder).toHaveBeenCalledTimes(1);
  });

  it("updates step indicator on Step 3 (3 active, 1 inactive)", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));

    const dots = screen.getByRole("dialog").querySelectorAll(".rounded-full");
    expect(dots[0].className).toContain("bg-accent");
    expect(dots[1].className).toContain("bg-accent");
    expect(dots[2].className).toContain("bg-accent");
    expect(dots[3].className).toContain("bg-warm-border");
  });

  // --- Auto-advance Step 3 → Step 4 ---

  it("auto-advances to Step 4 (Tips) when import completes", () => {
    const { rerender } = renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));
    expect(screen.getByText("onboarding.import.title")).toBeInTheDocument();

    mockLastCompletedAt = Date.now();
    mockPhase = "done";
    rerender(
      <OnboardingProvider>
        <OnboardingWizard {...props} />
      </OnboardingProvider>
    );

    expect(screen.getByText("onboarding.tips.title")).toBeInTheDocument();
    expect(screen.queryByText("onboarding.import.title")).not.toBeInTheDocument();
  });

  it("does NOT auto-advance when import is cancelled", () => {
    const { rerender } = renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));

    mockLastCompletedAt = Date.now();
    mockPhase = "cancelled";
    rerender(
      <OnboardingProvider>
        <OnboardingWizard {...props} />
      </OnboardingProvider>
    );

    expect(screen.getByText("onboarding.import.title")).toBeInTheDocument();
    expect(screen.queryByText("onboarding.tips.title")).not.toBeInTheDocument();
  });

  // --- Tips (Step 4) ---

  it("shows tip cards and Start Reading on Step 4", () => {
    const { rerender } = renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));
    mockLastCompletedAt = Date.now();
    mockPhase = "done";
    rerender(
      <OnboardingProvider>
        <OnboardingWizard {...props} />
      </OnboardingProvider>
    );

    expect(screen.getByText("onboarding.tips.title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.tips.subtitle")).toBeInTheDocument();
    expect(screen.getByText("onboarding.tips.focus")).toBeInTheDocument();
    expect(screen.getByText("onboarding.tips.focusDesc")).toBeInTheDocument();
    expect(screen.getByText("onboarding.tips.catalogs")).toBeInTheDocument();
    expect(screen.getByText("onboarding.tips.catalogsDesc")).toBeInTheDocument();
    expect(screen.getByText("onboarding.tips.dragDrop")).toBeInTheDocument();
    expect(screen.getByText("onboarding.tips.dragDropDesc")).toBeInTheDocument();
    expect(screen.getByText("onboarding.tips.cta")).toBeInTheDocument();
  });

  it("all 4 step indicator dots active on Step 4", () => {
    const { rerender } = renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));
    mockLastCompletedAt = Date.now();
    mockPhase = "done";
    rerender(
      <OnboardingProvider>
        <OnboardingWizard {...props} />
      </OnboardingProvider>
    );

    const dots = screen.getByRole("dialog").querySelectorAll(".rounded-full");
    expect(dots[0].className).toContain("bg-accent");
    expect(dots[1].className).toContain("bg-accent");
    expect(dots[2].className).toContain("bg-accent");
    expect(dots[3].className).toContain("bg-accent");
  });

  it("Start Reading closes wizard and sets localStorage flag", () => {
    const { container, rerender } = renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));
    mockLastCompletedAt = Date.now();
    mockPhase = "done";
    rerender(
      <OnboardingProvider>
        <OnboardingWizard {...props} />
      </OnboardingProvider>
    );

    fireEvent.click(screen.getByText("onboarding.tips.cta"));
    expect(container.innerHTML).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  // --- Skip behavior ---

  it("skip on Step 1 closes wizard and sets flag", () => {
    const { container } = renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.skip"));
    expect(container.innerHTML).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("skip on the Import step closes wizard and sets flag", () => {
    const { container } = renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.preferences.cta"));
    fireEvent.click(screen.getByText("onboarding.welcome.skip"));
    expect(container.innerHTML).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });
});
