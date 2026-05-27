// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import OnboardingWizard from "./OnboardingWizard";
import { STORAGE_KEY } from "../hooks/useOnboarding";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../lib/useFocusTrap", () => ({
  useFocusTrap: () => ({ current: null }),
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
  });

  afterEach(() => {
    cleanup();
  });

  const noop = async () => {};
  const props = { onImport: noop, onImportFolder: noop };

  // --- Rendering ---

  it("renders Step 1 on first mount", () => {
    render(<OnboardingWizard {...props} />);
    expect(screen.getByText("onboarding.welcome.title")).toBeInTheDocument();
    expect(screen.getByText("onboarding.welcome.cta")).toBeInTheDocument();
    expect(screen.getByText("onboarding.welcome.subtitle")).toBeInTheDocument();
  });

  it("does not render when onboarding already completed", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { container } = render(<OnboardingWizard {...props} />);
    expect(container.innerHTML).toBe("");
  });

  it("has dialog a11y attributes", () => {
    render(<OnboardingWizard {...props} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "onboarding-title");
    expect(screen.getByText("onboarding.welcome.title")).toHaveAttribute("id", "onboarding-title");
  });

  it("renders step indicator with 1 active and 2 inactive dots", () => {
    render(<OnboardingWizard {...props} />);
    const dots = screen.getByRole("dialog").querySelectorAll(".rounded-full");
    expect(dots).toHaveLength(3);
    expect(dots[0].className).toContain("bg-accent");
    expect(dots[1].className).toContain("bg-warm-border");
    expect(dots[2].className).toContain("bg-warm-border");
  });

  // --- Step 1 → Step 2 ---

  it("advances to Step 2 when CTA clicked", () => {
    render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));

    expect(screen.getByText("onboarding.import.title")).toBeInTheDocument();
    expect(screen.queryByText("onboarding.welcome.title")).not.toBeInTheDocument();
  });

  it("shows import options on Step 2", () => {
    render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));

    expect(screen.getByText("onboarding.import.addFiles")).toBeInTheDocument();
    expect(screen.getByText("onboarding.import.addFilesHint")).toBeInTheDocument();
    expect(screen.getByText("onboarding.import.importFolder")).toBeInTheDocument();
    expect(screen.getByText("onboarding.import.importFolderHint")).toBeInTheDocument();
    expect(screen.getByText("onboarding.import.dragDrop")).toBeInTheDocument();
  });

  it("calls onImport when Add Files clicked", () => {
    const onImport = vi.fn(async () => {});
    render(<OnboardingWizard onImport={onImport} onImportFolder={noop} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.import.addFiles"));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("calls onImportFolder when Import Folder clicked", () => {
    const onImportFolder = vi.fn(async () => {});
    render(<OnboardingWizard onImport={noop} onImportFolder={onImportFolder} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.import.importFolder"));
    expect(onImportFolder).toHaveBeenCalledTimes(1);
  });

  it("updates step indicator on Step 2 (2 active, 1 inactive)", () => {
    render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));

    const dots = screen.getByRole("dialog").querySelectorAll(".rounded-full");
    expect(dots[0].className).toContain("bg-accent");
    expect(dots[1].className).toContain("bg-accent");
    expect(dots[2].className).toContain("bg-warm-border");
  });

  // --- Auto-advance Step 2 → Step 3 ---

  it("auto-advances to Step 3 when import completes", () => {
    const { rerender } = render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    expect(screen.getByText("onboarding.import.title")).toBeInTheDocument();

    mockLastCompletedAt = Date.now();
    mockPhase = "done";
    rerender(<OnboardingWizard {...props} />);

    expect(screen.getByText("onboarding.tips.title")).toBeInTheDocument();
    expect(screen.queryByText("onboarding.import.title")).not.toBeInTheDocument();
  });

  it("does NOT auto-advance when import is cancelled", () => {
    const { rerender } = render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));

    mockLastCompletedAt = Date.now();
    mockPhase = "cancelled";
    rerender(<OnboardingWizard {...props} />);

    expect(screen.getByText("onboarding.import.title")).toBeInTheDocument();
    expect(screen.queryByText("onboarding.tips.title")).not.toBeInTheDocument();
  });

  // --- Step 3 (Tips) ---

  it("shows tip cards and Start Reading on Step 3", () => {
    const { rerender } = render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    mockLastCompletedAt = Date.now();
    mockPhase = "done";
    rerender(<OnboardingWizard {...props} />);

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

  it("all 3 step indicator dots active on Step 3", () => {
    const { rerender } = render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    mockLastCompletedAt = Date.now();
    mockPhase = "done";
    rerender(<OnboardingWizard {...props} />);

    const dots = screen.getByRole("dialog").querySelectorAll(".rounded-full");
    expect(dots[0].className).toContain("bg-accent");
    expect(dots[1].className).toContain("bg-accent");
    expect(dots[2].className).toContain("bg-accent");
  });

  it("Start Reading closes wizard and sets localStorage flag", () => {
    const { container, rerender } = render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    mockLastCompletedAt = Date.now();
    mockPhase = "done";
    rerender(<OnboardingWizard {...props} />);

    fireEvent.click(screen.getByText("onboarding.tips.cta"));
    expect(container.innerHTML).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  // --- Skip behavior ---

  it("skip on Step 1 closes wizard and sets flag", () => {
    const { container } = render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.skip"));
    expect(container.innerHTML).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("skip on Step 2 closes wizard and sets flag", () => {
    const { container } = render(<OnboardingWizard {...props} />);
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    fireEvent.click(screen.getByText("onboarding.welcome.skip"));
    expect(container.innerHTML).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });
});
