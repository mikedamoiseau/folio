# Onboarding Preferences Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a combined Preferences step (language, theme mode, font family, font size, import mode) to the onboarding wizard, and make the whole wizard re-runnable from a SettingsPanel menu entry.

**Architecture:** Lift the existing `useOnboarding` hook (currently private to `OnboardingWizard`) into an app-level `OnboardingContext` so the wizard and the SettingsPanel re-run button share one state. Insert a `PreferencesStep` between Welcome and Import; the step calls existing setters (`ThemeContext`, `i18n.changeLanguage`, `set_setting_value`) which already persist — no new persistence layer.

**Tech Stack:** React 19, TypeScript, Tailwind v4, react-i18next, Tauri v2 IPC (`invoke`), Vitest + @testing-library/react.

---

## File Structure

- `src/hooks/useOnboarding.ts` — MODIFY: 4 steps, add `restart()`
- `src/hooks/useOnboarding.test.ts` — MODIFY: update step-cap tests, add `restart()` test
- `src/context/OnboardingContext.tsx` — CREATE: provider + `useOnboardingContext()`
- `src/context/OnboardingContext.test.tsx` — CREATE: provider state + restart
- `src/lib/themes.ts` — MODIFY: add `FONT_OPTIONS`
- `src/components/OnboardingWizard.tsx` — MODIFY: generalize `StepIndicator`, add `PreferencesStep`, reorder steps, consume context
- `src/components/OnboardingWizard.test.tsx` — MODIFY: wrap in provider, adjust step order, add preferences tests
- `src/components/SettingsPanel.tsx` — MODIFY: use `FONT_OPTIONS`, add "Re-run setup wizard" button
- `src/App.tsx` — MODIFY: wrap `AppShell` in `OnboardingProvider`
- `src/locales/en.json` — MODIFY: add `onboarding.preferences.*` keys (fr relies on en fallback, matching existing onboarding convention)

**Conventions discovered (use these exact values):**
- import_mode values are `"import"` (copy) and `"link"` — NOT "copy".
- Theme modes offered: `light`, `dark`, `system`, `sepia` (omit `custom`).
- Font keys/css (built-ins only):
  - `serif` → `'"Lora Variable", Georgia, serif'` (label "Lora")
  - `literata` → `'"Literata Variable", Georgia, serif'` (label "Literata")
  - `sans-serif` → `'"DM Sans Variable", system-ui, sans-serif'` (label "DM Sans")
  - `dyslexic` → `'"OpenDyslexic", sans-serif'` (label "OpenDyslexic")
- `import { invoke } from "@tauri-apps/api/core";`
- `import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../context/ThemeContext";`
- `import { LANGUAGES } from "../i18n";` (re-exported via `src/i18n.ts`)
- localStorage flag key: `STORAGE_KEY = "folio-onboarding-complete"`

---

## Task 1: useOnboarding — 4 steps + restart()

**Files:**
- Modify: `src/hooks/useOnboarding.ts`
- Test: `src/hooks/useOnboarding.test.ts`

- [ ] **Step 1: Update existing tests for 4 steps + add restart test**

Replace the `advance()` step tests and add a restart test in `src/hooks/useOnboarding.test.ts`. Change the two existing `advance` tests and append a new one:

```ts
  it("advance() increments step from 1 up to 4", () => {
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.currentStep).toBe(1);

    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(2);

    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(3);

    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(4);
  });

  it("advance() does not go past step 4", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.advance());
    act(() => result.current.advance());
    act(() => result.current.advance());
    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(4);
  });

  it("restart() reactivates, resets to step 1, clears flag", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.isActive).toBe(false);

    act(() => result.current.restart());
    expect(result.current.isActive).toBe(true);
    expect(result.current.currentStep).toBe(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(null);
  });
```

Also update the `complete()` test to advance three times (so it starts from a non-1 step) — it currently advances twice; leave it, it still works. No change needed there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/hooks/useOnboarding.test.ts`
Expected: FAIL — `advance() increments ... up to 4` fails (caps at 3), `restart` is not a function.

- [ ] **Step 3: Implement 4 steps + restart in the hook**

Replace `src/hooks/useOnboarding.ts` with:

```ts
import { useState, useCallback } from "react";

export const STORAGE_KEY = "folio-onboarding-complete";

type Step = 1 | 2 | 3 | 4;

export interface UseOnboarding {
  isActive: boolean;
  currentStep: Step;
  advance: () => void;
  skip: () => void;
  complete: () => void;
  restart: () => void;
}

export function useOnboarding(): UseOnboarding {
  const [isActive, setIsActive] = useState(
    () => localStorage.getItem(STORAGE_KEY) !== "true"
  );
  const [currentStep, setCurrentStep] = useState<Step>(1);

  const dismiss = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, "true");
    setIsActive(false);
  }, []);

  const advance = useCallback(() => {
    setCurrentStep((s) => (s < 4 ? ((s + 1) as Step) : s));
  }, []);

  const restart = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setCurrentStep(1);
    setIsActive(true);
  }, []);

  return { isActive, currentStep, advance, skip: dismiss, complete: dismiss, restart };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/hooks/useOnboarding.test.ts`
Expected: PASS (all useOnboarding tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOnboarding.ts src/hooks/useOnboarding.test.ts
git commit -m "feat(onboarding): 4-step support and restart() in useOnboarding"
```

---

## Task 2: OnboardingContext provider

**Files:**
- Create: `src/context/OnboardingContext.tsx`
- Test: `src/context/OnboardingContext.test.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/context/OnboardingContext.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingProvider, useOnboardingContext } from "./OnboardingContext";
import { STORAGE_KEY } from "../hooks/useOnboarding";

function Probe() {
  const { isActive, currentStep, advance, restart } = useOnboardingContext();
  return (
    <div>
      <span data-testid="active">{String(isActive)}</span>
      <span data-testid="step">{currentStep}</span>
      <button onClick={advance}>advance</button>
      <button onClick={restart}>restart</button>
    </div>
  );
}

describe("OnboardingContext", () => {
  beforeEach(() => localStorage.clear());

  it("provides onboarding state to consumers", () => {
    render(
      <OnboardingProvider>
        <Probe />
      </OnboardingProvider>
    );
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("step")).toHaveTextContent("1");
  });

  it("advance updates shared step", () => {
    render(
      <OnboardingProvider>
        <Probe />
      </OnboardingProvider>
    );
    fireEvent.click(screen.getByText("advance"));
    expect(screen.getByTestId("step")).toHaveTextContent("2");
  });

  it("restart reactivates after completion", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    render(
      <OnboardingProvider>
        <Probe />
      </OnboardingProvider>
    );
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    fireEvent.click(screen.getByText("restart"));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("step")).toHaveTextContent("1");
  });

  it("throws when used outside provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow();
    spy.mockRestore();
  });
});
```

Add `vi` to the import: `import { describe, it, expect, beforeEach, vi } from "vitest";`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/context/OnboardingContext.test.tsx`
Expected: FAIL — module `./OnboardingContext` does not exist.

- [ ] **Step 3: Implement the provider**

Create `src/context/OnboardingContext.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";
import { useOnboarding, type UseOnboarding } from "../hooks/useOnboarding";

const OnboardingContext = createContext<UseOnboarding | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const value = useOnboarding();
  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboardingContext(): UseOnboarding {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboardingContext must be used within OnboardingProvider");
  return ctx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/context/OnboardingContext.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wrap AppShell in the provider**

In `src/App.tsx`, add the import after the ImportProvider import:

```tsx
import { OnboardingProvider } from "./context/OnboardingContext";
```

Then wrap `AppShell` inside `ImportProvider` (so the wizard's `useImport` still resolves, and both Library and SettingsPanel sit under the provider). Replace the `App` function body:

```tsx
function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ImportProvider>
          <OnboardingProvider>
            <BrowserRouter>
              <AppShell />
            </BrowserRouter>
          </OnboardingProvider>
        </ImportProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 6: Type-check + commit**

Run: `npm run type-check`
Expected: no errors.

```bash
git add src/context/OnboardingContext.tsx src/context/OnboardingContext.test.tsx src/App.tsx
git commit -m "feat(onboarding): add OnboardingContext provider and wrap app"
```

---

## Task 3: Extract FONT_OPTIONS to themes.ts

**Files:**
- Modify: `src/lib/themes.ts`
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add FONT_OPTIONS constant to themes.ts**

Append to `src/lib/themes.ts` (after the `isValidColorMode` function):

```ts
// ── Built-in reading fonts ──────────────────────────────────

export interface FontOption {
  key: string;
  label: string;
  css: string;
}

export const FONT_OPTIONS: readonly FontOption[] = [
  { key: "serif", label: "Lora", css: '"Lora Variable", Georgia, serif' },
  { key: "literata", label: "Literata", css: '"Literata Variable", Georgia, serif' },
  { key: "sans-serif", label: "DM Sans", css: '"DM Sans Variable", system-ui, sans-serif' },
  { key: "dyslexic", label: "OpenDyslexic", css: '"OpenDyslexic", sans-serif' },
] as const;
```

- [ ] **Step 2: Use FONT_OPTIONS in SettingsPanel**

In `src/components/SettingsPanel.tsx`, add `FONT_OPTIONS` to the themes import. Find the existing themes import (line ~14, `from "../lib/themes"`) and add `FONT_OPTIONS` to it.

Then replace the inline array (the `{([ ... ] as const).map(...)}` block at ~line 1306) so the map iterates `FONT_OPTIONS`:

```tsx
                {FONT_OPTIONS.map((option) => (
```

Leave the rest of the `.map` body unchanged. Delete only the inline array literal that previously fed the map.

- [ ] **Step 3: Run type-check + existing SettingsPanel tests**

Run: `npm run type-check`
Expected: no errors.

Run: `npm run test -- src/components/`
Expected: PASS (no behavior change — same fonts render).

- [ ] **Step 4: Commit**

```bash
git add src/lib/themes.ts src/components/SettingsPanel.tsx
git commit -m "refactor(settings): extract FONT_OPTIONS to themes.ts"
```

---

## Task 4: Add i18n keys for the Preferences step

**Files:**
- Modify: `src/locales/en.json`

- [ ] **Step 1: Add the preferences block**

In `src/locales/en.json`, inside the `"onboarding"` object, add a `"preferences"` key between `"welcome"` and `"import"`:

```json
  "onboarding": {
    "welcome": { ... unchanged ... },
    "preferences": {
      "title": "Make It Yours",
      "subtitle": "Set up the basics — you can change these any time in Settings.",
      "language": "Language",
      "theme": "Theme",
      "themeLight": "Light",
      "themeDark": "Dark",
      "themeSystem": "System",
      "themeSepia": "Sepia",
      "font": "Reading font",
      "fontSize": "Font size",
      "importMode": "When importing books",
      "importModeCopy": "Copy to library",
      "importModeLink": "Link to original",
      "cta": "Continue"
    },
    "import": { ... unchanged ... },
    "tips": { ... unchanged ... }
  }
```

(Insert only the `"preferences"` object; keep the existing welcome/import/tips intact. fr.json is left as-is — it has no onboarding keys and falls back to en, matching the current convention.)

- [ ] **Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 3: Commit**

```bash
git add src/locales/en.json
git commit -m "feat(onboarding): add i18n keys for preferences step"
```

---

## Task 5: PreferencesStep + wizard reorder + context consumption

**Files:**
- Modify: `src/components/OnboardingWizard.tsx`
- Test: `src/components/OnboardingWizard.test.tsx`

This is the central task. The wizard moves from a private hook to the context, the step indicator generalizes to 4, and a new Preferences step becomes step 2 (Import → 3, Tips → 4).

- [ ] **Step 1: Generalize StepIndicator (implementation first — it has no standalone test)**

In `src/components/OnboardingWizard.tsx`, replace `StepIndicator` and its `current` type:

```tsx
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
```

- [ ] **Step 2: Add the PreferencesStep component**

Add these imports at the top of `src/components/OnboardingWizard.tsx`:

```tsx
import { useState as useReactState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../context/ThemeContext";
import { FONT_OPTIONS, type ColorMode } from "../lib/themes";
import { LANGUAGES } from "../i18n";
```

(If `useState` is already imported from "react" on line 1, add `useState` there instead of the aliased `useReactState`, and use `useState` below.)

Add the component (place it above the default-export `OnboardingWizard`):

```tsx
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
```

Ensure `useState` and `useEffect` are imported from "react" at the top (the file already imports `useEffect, useRef`; add `useState`).

- [ ] **Step 3: Consume context and reorder steps in the default export**

In the `OnboardingWizard` default export, replace the hook import and the step switch.

Replace:
```tsx
import { useOnboarding } from "../hooks/useOnboarding";
```
with:
```tsx
import { useOnboardingContext } from "../context/OnboardingContext";
```

Replace the line:
```tsx
  const { isActive, currentStep, advance, skip, complete } = useOnboarding();
```
with:
```tsx
  const { isActive, currentStep, advance, skip, complete } = useOnboardingContext();
```

Update the auto-advance effect guard — Import is now step 3 (was 2):
```tsx
  useEffect(() => {
    if (currentStep !== 3) return;
    if (
      importCtx.lastCompletedAt !== null &&
      importCtx.lastCompletedAt !== prevCompletedRef.current &&
      importCtx.progress?.phase !== "cancelled"
    ) {
      prevCompletedRef.current = importCtx.lastCompletedAt;
      advance();
    }
  }, [importCtx.lastCompletedAt, importCtx.progress?.phase, currentStep, advance]);
```

Replace the `<StepIndicator current={currentStep} />` and the step switch with:
```tsx
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
          />
        )}
        {currentStep === 4 && (
          <TipsStep onComplete={complete} />
        )}
```

- [ ] **Step 4: Update OnboardingWizard.test.tsx**

The wizard now requires the provider and the ThemeContext + i18n. Update `src/components/OnboardingWizard.test.tsx`:

1. Extend the `react-i18next` mock to expose `i18n`:
```tsx
const mockChangeLanguage = vi.fn();
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: mockChangeLanguage },
  }),
}));
```

2. Mock `../i18n` (so importing it doesn't run i18next init) and `../context/ThemeContext`:
```tsx
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
```

3. Mock `invoke` (Preferences step reads/writes import_mode):
```tsx
const mockInvoke = vi.fn(async () => null);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
```

4. Wrap renders in the provider. Add at top:
```tsx
import { OnboardingProvider } from "../context/OnboardingContext";
```
Replace the bare `render(<OnboardingWizard {...} />)` calls with a helper:
```tsx
  const renderWizard = (p = props) =>
    render(
      <OnboardingProvider>
        <OnboardingWizard {...p} />
      </OnboardingProvider>
    );
```
Use `renderWizard(...)` in every test. For tests that use `rerender`, capture it from `renderWizard` and rerender with the same provider wrapper:
```tsx
    const { rerender } = renderWizard();
    // ...
    rerender(
      <OnboardingProvider>
        <OnboardingWizard {...props} />
      </OnboardingProvider>
    );
```

5. Fix step-count and step-order assertions:
   - `renders step indicator` test: expect `toHaveLength(4)`; dots[0] active, dots[1..3] `bg-warm-border`.
   - `advances to Step 2` test: clicking welcome CTA now shows **preferences**, not import. Change to:
```tsx
  it("advances to Preferences (Step 2) when CTA clicked", () => {
    renderWizard();
    fireEvent.click(screen.getByText("onboarding.welcome.cta"));
    expect(screen.getByText("onboarding.preferences.title")).toBeInTheDocument();
    expect(screen.queryByText("onboarding.welcome.title")).not.toBeInTheDocument();
  });
```
   - The import-options tests (`shows import options on Step 2`, `calls onImport`, `calls onImportFolder`, `updates step indicator on Step 2`) must advance twice (welcome → preferences → import). Insert a click on `onboarding.preferences.cta` after the welcome CTA click in each. Rename to "Step 3". Update the step-indicator-on-import test to expect dots[0..2] active, dots[3] inactive.
   - The auto-advance tests: after reaching import (now step 3), advance via welcome CTA + preferences CTA, then set `mockLastCompletedAt`. Update accordingly.

6. Add new Preferences tests:
```tsx
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
```

Add `vi` to the vitest import if not already present (it is).

- [ ] **Step 5: Run the wizard tests**

Run: `npm run test -- src/components/OnboardingWizard.test.tsx`
Expected: PASS (all rendering, step-order, and new preferences tests).

- [ ] **Step 6: Type-check**

Run: `npm run type-check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/OnboardingWizard.tsx src/components/OnboardingWizard.test.tsx
git commit -m "feat(onboarding): add Preferences step and consume OnboardingContext"
```

---

## Task 6: "Re-run setup wizard" button in SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/locales/en.json`

- [ ] **Step 1: Add the i18n key**

In `src/locales/en.json`, inside the `"settings"` object, add:
```json
    "rerunWizard": "Re-run setup wizard",
```
Verify JSON: `node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8')); console.log('valid')"` → `valid`.

- [ ] **Step 2: Wire the button**

In `src/components/SettingsPanel.tsx`:

Add the import:
```tsx
import { useOnboardingContext } from "../context/OnboardingContext";
```

Inside the `SettingsPanel` component body (near the other hooks at the top), add:
```tsx
  const { restart: restartOnboarding } = useOnboardingContext();
```

Add a button next to the existing "View Activity Log" button (the block with `setShowActivityLog`). Insert after that button:
```tsx
              <button
                type="button"
                onClick={() => {
                  onClose();
                  restartOnboarding();
                }}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
              >
                {t("settings.rerunWizard")}
              </button>
```

(`onClose()` closes the settings panel so the wizard modal is visible on top.)

- [ ] **Step 3: Type-check**

Run: `npm run type-check`
Expected: no errors.

Note: any SettingsPanel test that renders `<SettingsPanel>` directly will now need an `OnboardingProvider` wrapper. Run the SettingsPanel tests and, if a "must be used within OnboardingProvider" error appears, wrap the render in `<OnboardingProvider>` in that test file (import from `../context/OnboardingContext`).

- [ ] **Step 4: Run SettingsPanel tests + full frontend suite**

Run: `npm run test`
Expected: PASS. Fix any provider-wrapper errors per the note above.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPanel.tsx src/locales/en.json
git commit -m "feat(settings): add re-run setup wizard button"
```

---

## Task 7: Full verification

- [ ] **Step 1: Type-check**

Run: `npm run type-check`
Expected: no errors.

- [ ] **Step 2: Full frontend test suite**

Run: `npm run test`
Expected: all PASS.

- [ ] **Step 3: Manual smoke (optional, requires app)**

Run: `npm run tauri dev`
- Clear onboarding: in devtools console `localStorage.removeItem("folio-onboarding-complete")` then reload.
- Verify: Welcome → Preferences (change language live, pick theme/font/size/import mode) → Import → Tips.
- Open Settings → "Re-run setup wizard" → wizard reappears at step 1.

- [ ] **Step 4: Final commit (if any manual fixes)**

```bash
git add -A
git commit -m "chore(onboarding): verification pass"
```

---

## Self-Review

**Spec coverage:**
- 4-step flow (Welcome→Preferences→Import→Tips) → Tasks 1, 5 ✓
- Preferences: language, theme mode, font family, font size, import mode → Task 5 ✓
- Existing setters / no new persistence → Task 5 (uses ThemeContext, i18n, set_setting_value) ✓
- Theme subset light/dark/system/sepia; font built-ins only → Task 5 `THEME_CHOICES`, `FONT_OPTIONS` ✓
- Lift useOnboarding to context → Task 2 ✓
- restart() + menu re-entry in SettingsPanel → Tasks 1, 6 ✓
- FONT_OPTIONS extraction → Task 3 ✓
- i18n keys → Tasks 4, 6 ✓
- App provider wrap → Task 2 ✓
- Tests (hook 4-step/restart, context, preferences controls, re-run) → Tasks 1, 2, 5, 6 ✓

**Type consistency:** `restart` named identically in hook, context, SettingsPanel. import_mode values `"import"`/`"link"` consistent across Preferences step and SettingsPanel. `FONT_OPTIONS` shape (`key/label/css`) matches SettingsPanel usage. Theme `ColorMode` values match `COLOR_MODES`.

**Placeholder scan:** none — every code step shows full content.

**Risk notes from spec addressed:** language change re-renders later steps (step state in context survives, controlled by `currentStep`); `restart()` clears the persisted flag (Task 1 `localStorage.removeItem`).
