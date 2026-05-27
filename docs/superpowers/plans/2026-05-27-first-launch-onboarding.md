# First-Launch Guided Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 3-step modal wizard on first launch that welcomes the user, guides them to import their first book, then shows quick tips — controlled by a single localStorage flag.

**Architecture:** New `useOnboarding` hook reads/writes `folio-onboarding-complete` in localStorage. New `OnboardingWizard.tsx` renders a modal overlay with three step components. Library.tsx conditionally renders the wizard and passes its existing import handlers. The book illustration is extracted from EmptyState into a shared component.

**Tech Stack:** React 19, Tailwind CSS v4, Vitest, react-i18next, Tauri IPC (existing `import_books`/`import_folder` commands)

**Spec:** `docs/superpowers/specs/2026-05-26-first-launch-onboarding-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/hooks/useOnboarding.ts` | Create | Onboarding state: active flag, current step, advance/skip/complete |
| `src/hooks/useOnboarding.test.ts` | Create | Unit tests for the hook |
| `src/components/BookStackIllustration.tsx` | Create | Shared book-stack illustration extracted from EmptyState |
| `src/components/OnboardingWizard.tsx` | Create | Modal overlay with 3 steps, step indicator, animations |
| `src/components/OnboardingWizard.test.tsx` | Create | Component tests |
| `src/components/EmptyState.tsx` | Modify | Replace inline illustration with `<BookStackIllustration />` |
| `src/screens/Library.tsx` | Modify | Render `<OnboardingWizard>` when onboarding active |
| `src/locales/en.json` | Modify | Add `onboarding.*` keys |

---

### Task 1: useOnboarding Hook

**Files:**
- Create: `src/hooks/useOnboarding.ts`
- Create: `src/hooks/useOnboarding.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/useOnboarding.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOnboarding } from "./useOnboarding";

const STORAGE_KEY = "folio-onboarding-complete";

describe("useOnboarding", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns isActive true when localStorage flag absent", () => {
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.isActive).toBe(true);
    expect(result.current.currentStep).toBe(1);
  });

  it("returns isActive false when localStorage flag set", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.isActive).toBe(false);
  });

  it("advance() increments step from 1 to 2 to 3", () => {
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.currentStep).toBe(1);

    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(2);

    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(3);
  });

  it("advance() does not go past step 3", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.advance());
    act(() => result.current.advance());
    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(3);
  });

  it("skip() sets localStorage flag and isActive to false", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.skip());
    expect(result.current.isActive).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("complete() sets localStorage flag and isActive to false", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.advance());
    act(() => result.current.advance());
    act(() => result.current.complete());
    expect(result.current.isActive).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/useOnboarding.test.ts`
Expected: FAIL — module `./useOnboarding` has no export `useOnboarding`

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useOnboarding.ts`:

```typescript
import { useState, useCallback } from "react";

const STORAGE_KEY = "folio-onboarding-complete";

type Step = 1 | 2 | 3;

export interface UseOnboarding {
  isActive: boolean;
  currentStep: Step;
  advance: () => void;
  skip: () => void;
  complete: () => void;
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
    setCurrentStep((s) => (s < 3 ? ((s + 1) as Step) : s));
  }, []);

  return { isActive, currentStep, advance, skip: dismiss, complete: dismiss };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useOnboarding.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOnboarding.ts src/hooks/useOnboarding.test.ts
git commit -m "feat(onboarding): add useOnboarding hook with localStorage state"
```

---

### Task 2: BookStackIllustration Extraction

**Files:**
- Create: `src/components/BookStackIllustration.tsx`
- Modify: `src/components/EmptyState.tsx`

- [ ] **Step 1: Create BookStackIllustration component**

Create `src/components/BookStackIllustration.tsx`:

```tsx
export default function BookStackIllustration() {
  return (
    <div className="relative w-28 h-28 flex items-end justify-center">
      {/* Back book */}
      <div
        className="absolute bottom-0 left-3 w-16 h-20 rounded-sm bg-warm-subtle border border-warm-border shadow-sm rotate-[-8deg] origin-bottom"
        style={{ animation: "empty-book-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.1s both" }}
      />
      {/* Middle book */}
      <div
        className="absolute bottom-0 left-6 w-16 h-[72px] rounded-sm bg-warm-border shadow-sm rotate-[3deg] origin-bottom"
        style={{ animation: "empty-book-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.25s both" }}
      />
      {/* Front book */}
      <div
        className="relative w-16 h-[84px] rounded-sm bg-accent-light border border-accent/30 shadow-md flex flex-col items-center justify-center gap-2"
        style={{ animation: "empty-book-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.4s both" }}
      >
        <div className="w-8 h-px bg-accent/40 rounded" />
        <div className="w-6 h-px bg-accent/30 rounded" />
        <div className="w-8 h-px bg-accent/40 rounded" />
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-accent mt-1">
          <path
            d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace inline illustration in EmptyState**

In `src/components/EmptyState.tsx`, add the import at the top:

```typescript
import BookStackIllustration from "./BookStackIllustration";
```

Then replace the entire illustration div (the `<div className="mb-8 relative w-28 h-28 ...">` block with all three book children) with:

```tsx
<div className="mb-8">
  <BookStackIllustration />
</div>
```

The full EmptyState component becomes:

```tsx
import { useTranslation } from "react-i18next";
import BookStackIllustration from "./BookStackIllustration";

interface EmptyStateProps {
  onImport: () => void;
  onImportFolder: () => void;
  onBrowseCatalogs?: () => void;
}

export default function EmptyState({ onImport, onImportFolder, onBrowseCatalogs }: EmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full max-w-xs mx-auto text-center gap-0">
      <div className="mb-8">
        <BookStackIllustration />
      </div>

      <h2 className="font-serif text-2xl font-semibold text-ink mb-2" style={{ animation: "fade-in 0.3s ease 0.55s both" }}>
        {t("empty.title")}
      </h2>
      <p className="text-sm text-ink-muted mb-7 leading-relaxed" style={{ animation: "fade-in 0.3s ease 0.65s both" }}>
        {t("empty.subtitle")}
      </p>

      <div className="flex items-center gap-3" style={{ animation: "fade-in 0.3s ease 0.75s both" }}>
        <button
          type="button"
          onClick={onImport}
          className="px-5 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-hover focus:outline-2 focus:outline-accent focus:outline-offset-2 active:scale-[0.97] transition-all duration-150 shadow-sm"
        >
          {t("empty.addBooks")}
        </button>
        <button
          type="button"
          onClick={onImportFolder}
          className="px-5 py-2.5 text-sm font-medium text-ink-muted bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors"
        >
          {t("empty.importFolder")}
        </button>
      </div>

      {onBrowseCatalogs && (
        <button
          type="button"
          onClick={onBrowseCatalogs}
          className="mt-4 text-sm text-accent hover:text-accent-hover transition-colors"
        >
          {t("empty.browseCatalogs")}
        </button>
      )}

      <p className="mt-4 text-xs text-ink-muted">
        {t("empty.dragAndDrop")}
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Run type-check and existing tests**

Run: `npx vitest run && npm run type-check`
Expected: All existing tests still pass, no type errors. EmptyState renders identically.

- [ ] **Step 4: Commit**

```bash
git add src/components/BookStackIllustration.tsx src/components/EmptyState.tsx
git commit -m "refactor: extract BookStackIllustration from EmptyState for reuse"
```

---

### Task 3: i18n Keys

**Files:**
- Modify: `src/locales/en.json`

- [ ] **Step 1: Add onboarding keys to en.json**

Add a new `"onboarding"` section to `src/locales/en.json` (at the top level, alongside `"empty"`, `"library"`, etc.):

```json
"onboarding": {
  "welcome": {
    "title": "Welcome to Folio",
    "subtitle": "Your personal reading companion. Let's get your first book on the shelf.",
    "cta": "Add Your First Book",
    "skip": "Skip",
    "skipHint": "you can always import later"
  },
  "import": {
    "title": "Import a Book",
    "subtitle": "Choose how to add your first book",
    "addFiles": "Add Files",
    "addFilesHint": "EPUB, PDF, CBZ, CBR, MOBI",
    "importFolder": "Import Folder",
    "importFolderHint": "Add all books from a folder",
    "dragDrop": "or drag & drop files here"
  },
  "tips": {
    "title": "You're All Set",
    "subtitle": "A few things to know",
    "focus": "Focus Mode",
    "focusDesc": "Press D while reading for a distraction-free experience",
    "catalogs": "Online Catalogs",
    "catalogsDesc": "Browse free books from Project Gutenberg, Standard Ebooks, and more",
    "dragDrop": "Drag & Drop",
    "dragDropDesc": "Drop book files anywhere in the app to import them instantly",
    "cta": "Start Reading"
  }
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `python3 -c "import json; json.load(open('src/locales/en.json')); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/locales/en.json
git commit -m "feat(onboarding): add i18n keys for onboarding wizard"
```

---

### Task 4: OnboardingWizard Component

**Files:**
- Create: `src/components/OnboardingWizard.tsx`
- Create: `src/components/OnboardingWizard.test.tsx`

- [ ] **Step 1: Write the failing component tests**

Create `src/components/OnboardingWizard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import OnboardingWizard from "./OnboardingWizard";

// Mock react-i18next — return the key as the translated string
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock ImportContext — SSR tests don't need real import functionality
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

const STORAGE_KEY = "folio-onboarding-complete";

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
    // Fixed overlay covering the screen
    expect(html).toContain("fixed");
    expect(html).toContain("inset-0");
  });

  it("renders step indicator dots", () => {
    const html = renderToString(
      <OnboardingWizard onImport={noop} onImportFolder={noop} />
    );
    // Should have step indicator with bg-accent for active step
    expect(html).toContain("bg-accent");
    expect(html).toContain("bg-warm-border");
  });

  it("renders skip link on Step 1", () => {
    const html = renderToString(
      <OnboardingWizard onImport={noop} onImportFolder={noop} />
    );
    expect(html).toContain("onboarding.welcome.skip");
  });

  it("does not render when onboarding already completed", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const html = renderToString(
      <OnboardingWizard onImport={noop} onImportFolder={noop} />
    );
    expect(html).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/OnboardingWizard.test.tsx`
Expected: FAIL — cannot resolve `./OnboardingWizard`

- [ ] **Step 3: Implement OnboardingWizard**

Create `src/components/OnboardingWizard.tsx`:

```tsx
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOnboarding } from "../hooks/useOnboarding";
import { useImport } from "../context/ImportContext";
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
      <h2 className="font-serif text-2xl font-semibold text-ink mb-2">
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
      <h2 className="font-serif text-2xl font-semibold text-ink mb-2">
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
      <h2 className="font-serif text-2xl font-semibold text-ink mb-2">
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

  // Auto-advance from Step 2 to Step 3 when an import completes
  useEffect(() => {
    if (currentStep !== 2) return;
    if (
      importCtx.lastCompletedAt !== null &&
      importCtx.lastCompletedAt !== prevCompletedRef.current
    ) {
      prevCompletedRef.current = importCtx.lastCompletedAt;
      advance();
    }
  }, [importCtx.lastCompletedAt, currentStep, advance]);

  if (!isActive) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/OnboardingWizard.test.tsx`
Expected: 5 tests PASS

- [ ] **Step 5: Run type-check**

Run: `npm run type-check`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/components/OnboardingWizard.tsx src/components/OnboardingWizard.test.tsx
git commit -m "feat(onboarding): add OnboardingWizard component with 3-step flow"
```

---

### Task 5: Wire Into Library.tsx

**Files:**
- Modify: `src/screens/Library.tsx`

- [ ] **Step 1: Add OnboardingWizard import**

Add at the top of `src/screens/Library.tsx`, alongside the other component imports:

```typescript
import OnboardingWizard from "../components/OnboardingWizard";
```

- [ ] **Step 2: Render OnboardingWizard in the JSX**

In Library.tsx, find the line that renders EmptyState (around line 1012):

```tsx
) : !hasBooks ? (
  <EmptyState onImport={handleImport} onImportFolder={handleImportFolder} />
```

Add the `<OnboardingWizard>` render **before** the content area `<div>` (around line 994, just above `{/* Content area */}`). The wizard sits outside the content flow as a fixed overlay:

```tsx
      <OnboardingWizard onImport={handleImport} onImportFolder={handleImportFolder} />

      {/* Content area */}
```

This renders the wizard as a fixed overlay over the entire Library screen. When the wizard is active, EmptyState is still visible behind the dimmed backdrop. When `isActive` is false, `OnboardingWizard` returns null.

- [ ] **Step 3: Run type-check and all tests**

Run: `npm run type-check && npx vitest run`
Expected: No type errors, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/screens/Library.tsx
git commit -m "feat(onboarding): wire OnboardingWizard into Library screen"
```

---

### Task 6: Manual Verification

- [ ] **Step 1: Clear localStorage and launch dev server**

Run: `npm run tauri dev`

In the browser devtools console, run:
```javascript
localStorage.removeItem("folio-onboarding-complete");
location.reload();
```

Expected: Onboarding wizard modal appears over the dimmed empty library.

- [ ] **Step 2: Test Step 1 → Step 2 transition**

Click "Add Your First Book" button.
Expected: Modal transitions to Step 2 (Import). Step indicator shows 2 of 3 dots filled.

- [ ] **Step 3: Test import from Step 2**

Click "Add Files" and select an EPUB/PDF from your filesystem.
Expected: Tauri file dialog opens. After selecting a file and import completes, modal auto-advances to Step 3 (Tips).

- [ ] **Step 4: Test Step 3 completion**

Click "Start Reading" on the tips screen.
Expected: Modal closes. Library shows the imported book. No onboarding wizard on next app restart.

- [ ] **Step 5: Test skip behavior**

Clear localStorage again and reload. Click "Skip" on Step 1.
Expected: Modal closes immediately. EmptyState visible. Wizard does not return on reload.

- [ ] **Step 6: Test dark mode**

Toggle dark mode in settings. Clear localStorage, reload.
Expected: All wizard elements use dark-mode tokens — readable text, correct backgrounds.

- [ ] **Step 7: Run full CI check suite**

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test && cd .. && npm run type-check && npx vitest run
```

Expected: All checks pass.

- [ ] **Step 8: Commit any fixes from manual verification**

If any adjustments were needed during verification, commit them:

```bash
git add -A
git commit -m "fix(onboarding): adjustments from manual verification"
```

Only create this commit if changes were made. Skip if everything worked on first pass.
