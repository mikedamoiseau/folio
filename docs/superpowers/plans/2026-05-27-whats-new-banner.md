# F-5-1: In-App "What's New" Banner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface release notes in-app via a dismissible banner, modal, Settings entry, and system tray item.

**Architecture:** Vite virtual-module plugin parses CHANGELOG.md at build time into typed JSON. A `useWhatsNew` hook manages visibility (feature flag + localStorage + onboarding guard). The banner sits above the Library toolbar; the modal is reachable from banner, Settings, and tray (via Tauri event).

**Tech Stack:** Vite plugin (Node), React 19, Tauri v2 IPC + events, Rust tray menu, SQLite feature flags, i18next, Vitest.

---

## File Map

### New Files

| File | Responsibility |
|------|----------------|
| `vite-plugin-release-notes.ts` | Build-time CHANGELOG.md parser; exports virtual module `virtual:release-notes` |
| `src/hooks/useWhatsNew.ts` | Banner/modal visibility, dismiss, feature-flag query, tray event listener |
| `src/components/WhatsNewBanner.tsx` | Full-width accent banner above Library toolbar |
| `src/components/WhatsNewModal.tsx` | Release notes modal grouped by category |

### Modified Files

| File | Change |
|------|--------|
| `vite.config.ts` | Import and register `releaseNotesPlugin` |
| `src/vite-env.d.ts` | Add `declare module "virtual:release-notes"` |
| `src/locales/en.json` | Add `whatsNew` namespace (7 keys) |
| `src/locales/fr.json` | Add `whatsNew` namespace (7 keys) |
| `folio-core/src/db.rs` | Seed `whats_new_banner` feature flag in `run_schema()` |
| `src/screens/Library.tsx` | Render `WhatsNewBanner` above error toast; consume `useWhatsNew` |
| `src/components/SettingsPanel.tsx` | Add "Release Notes" button in About accordion |
| `src-tauri/src/tray.rs` | Add "What's New" menu item; emit `whats-new-open` event |

---

### Task 1: Vite Plugin — CHANGELOG Parser

**Files:**
- Create: `vite-plugin-release-notes.ts`
- Modify: `vite.config.ts`
- Modify: `src/vite-env.d.ts`
- Test: `src/lib/__tests__/releaseNotes.test.ts`

- [ ] **Step 1: Write the parser as a pure function and its test**

Create `src/lib/__tests__/releaseNotes.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseChangelog } from "../../vite-plugin-release-notes";

const SAMPLE = `# Changelog

## [Unreleased]

### Added
- **Unreleased feature**. Should be skipped.

## [2.0.3] - 2026-05-18

### Added
- **OPDS feed primitives**. Public primitives for rendering OPDS Atom feeds.

## [2.0.0] - 2026-05-03

### Added
- **MOBI / AZW / AZW3 reading** (ROADMAP #34). Mobipocket and Kindle formats via libmobi.
- **Navigation history** (ROADMAP #36). Back/forward stack across the reader.

### Fixed
- **Web server deadlock on auto-start**. The auto-start path held the mutex.

### Changed
- **folio-core crate extraction** (ROADMAP #63). Modules now live in a separately-tested crate.

## [1.4.1] - 2026-04-15

### Added
- **Tag filter in library toolbar**. Searchable multi-select combobox.
`;

describe("parseChangelog", () => {
  const result = parseChangelog(SAMPLE, 3);

  it("skips Unreleased section", () => {
    expect(result.find((r) => r.version === "Unreleased")).toBeUndefined();
  });

  it("parses version and date", () => {
    expect(result[0]).toMatchObject({ version: "2.0.3", date: "2026-05-18" });
    expect(result[1]).toMatchObject({ version: "2.0.0", date: "2026-05-03" });
  });

  it("groups entries by category", () => {
    const v200 = result.find((r) => r.version === "2.0.0")!;
    expect(Object.keys(v200.categories)).toContain("Added");
    expect(Object.keys(v200.categories)).toContain("Fixed");
    expect(Object.keys(v200.categories)).toContain("Changed");
  });

  it("extracts bold title and description", () => {
    const v200 = result.find((r) => r.version === "2.0.0")!;
    expect(v200.categories["Added"][0]).toEqual({
      title: "MOBI / AZW / AZW3 reading",
      description: "(ROADMAP #34). Mobipocket and Kindle formats via libmobi.",
    });
  });

  it("limits to maxVersions", () => {
    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({ version: "1.4.1" });
  });

  it("handles entries without bold title gracefully", () => {
    const plain = parseChangelog("## [1.0.0] - 2026-01-01\n\n### Fixed\n- Plain entry without bold.\n", 1);
    expect(plain[0].categories["Fixed"][0]).toEqual({
      title: "Plain entry without bold.",
      description: "",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/__tests__/releaseNotes.test.ts`
Expected: FAIL — `parseChangelog` does not exist yet.

- [ ] **Step 3: Implement the plugin with exported parser**

Create `vite-plugin-release-notes.ts`:

```typescript
import { readFileSync } from "fs";
import { resolve } from "path";
import type { Plugin } from "vite";

export interface ReleaseEntry {
  title: string;
  description: string;
}

export interface ReleaseVersion {
  version: string;
  date: string;
  categories: Record<string, ReleaseEntry[]>;
}

const VERSION_RE = /^## \[(.+?)\]\s*-\s*(.+)$/;
const CATEGORY_RE = /^### (.+)$/;
const ENTRY_RE = /^- \*\*(.+?)\*\*(.*)$/;
const PLAIN_ENTRY_RE = /^- (.+)$/;

export function parseChangelog(raw: string, maxVersions = 3): ReleaseVersion[] {
  const lines = raw.split("\n");
  const versions: ReleaseVersion[] = [];
  let current: ReleaseVersion | null = null;
  let currentCategory = "";

  for (const line of lines) {
    const versionMatch = line.match(VERSION_RE);
    if (versionMatch) {
      if (versionMatch[1] === "Unreleased") {
        current = null;
        continue;
      }
      if (versions.length >= maxVersions) break;
      current = {
        version: versionMatch[1],
        date: versionMatch[2].trim(),
        categories: {},
      };
      versions.push(current);
      currentCategory = "";
      continue;
    }

    if (!current) continue;

    const categoryMatch = line.match(CATEGORY_RE);
    if (categoryMatch) {
      currentCategory = categoryMatch[1];
      if (!current.categories[currentCategory]) {
        current.categories[currentCategory] = [];
      }
      continue;
    }

    if (!currentCategory) continue;

    const entryMatch = line.match(ENTRY_RE);
    if (entryMatch) {
      current.categories[currentCategory].push({
        title: entryMatch[1],
        description: entryMatch[2].replace(/^\s*[.\-—]\s*/, "").replace(/\.\s*$/, ".").trim(),
      });
      continue;
    }

    const plainMatch = line.match(PLAIN_ENTRY_RE);
    if (plainMatch && !line.startsWith("  ")) {
      current.categories[currentCategory].push({
        title: plainMatch[1].replace(/\.\s*$/, ".").trim(),
        description: "",
      });
    }
  }

  return versions;
}

export default function releaseNotesPlugin(): Plugin {
  const virtualModuleId = "virtual:release-notes";
  const resolvedId = "\0" + virtualModuleId;

  return {
    name: "vite-plugin-release-notes",
    resolveId(id) {
      if (id === virtualModuleId) return resolvedId;
    },
    load(id) {
      if (id !== resolvedId) return;

      const changelogPath = resolve(__dirname, "CHANGELOG.md");
      const raw = readFileSync(changelogPath, "utf-8");
      const notes = parseChangelog(raw, 3);

      const pkgPath = resolve(__dirname, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

      return `export const releaseNotes = ${JSON.stringify(notes)};
export const appVersion = ${JSON.stringify(pkg.version)};
`;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/__tests__/releaseNotes.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Register plugin in vite.config.ts**

In `vite.config.ts`, add the import and register the plugin:

```typescript
import releaseNotesPlugin from "./vite-plugin-release-notes";
```

Add `releaseNotesPlugin()` to the `plugins` array:

```typescript
plugins: [react(), tailwindcss(), releaseNotesPlugin()],
```

- [ ] **Step 6: Add type declaration for virtual module**

In `src/vite-env.d.ts`, append:

```typescript
declare module "virtual:release-notes" {
  import type { ReleaseVersion } from "../vite-plugin-release-notes";
  export const releaseNotes: ReleaseVersion[];
  export const appVersion: string;
}
```

- [ ] **Step 7: Verify build compiles with plugin**

Run: `npm run build`
Expected: Build succeeds. The virtual module resolves without errors.

- [ ] **Step 8: Commit**

```bash
git add vite-plugin-release-notes.ts src/lib/__tests__/releaseNotes.test.ts vite.config.ts src/vite-env.d.ts
git commit -m "feat(whats-new): add Vite plugin to parse CHANGELOG.md at build time"
```

---

### Task 2: i18n Keys

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/fr.json`

- [ ] **Step 1: Add English translations**

Add `whatsNew` namespace to `src/locales/en.json` (at the end, before the closing `}`):

```json
"whatsNew": {
  "bannerTitle": "Folio {{version}}",
  "bannerSummary": "{{title}} and more",
  "bannerCta": "See what's new",
  "modalTitle": "What's New in Folio {{version}}",
  "modalFullChangelog": "See full changelog",
  "settingsButton": "Release Notes",
  "trayLabel": "What's New"
}
```

- [ ] **Step 2: Add French translations**

Add `whatsNew` namespace to `src/locales/fr.json`:

```json
"whatsNew": {
  "bannerTitle": "Folio {{version}}",
  "bannerSummary": "{{title}} et plus",
  "bannerCta": "Voir les nouveautés",
  "modalTitle": "Nouveautés de Folio {{version}}",
  "modalFullChangelog": "Voir le changelog complet",
  "settingsButton": "Notes de version",
  "trayLabel": "Nouveautés"
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `npm run type-check`
Expected: PASS — no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/fr.json
git commit -m "feat(whats-new): add i18n keys for banner, modal, and settings"
```

---

### Task 3: Feature Flag Seed

**Files:**
- Modify: `folio-core/src/db.rs`

- [ ] **Step 1: Add feature flag seed to run_schema()**

In `folio-core/src/db.rs`, in the `run_schema()` function, after the `CREATE TABLE IF NOT EXISTS feature_flags` statement, add:

```rust
conn.execute(
    "INSERT OR IGNORE INTO feature_flags (key, enabled, description) VALUES ('whats_new_banner', 1, 'Show What''s New banner after version updates')",
    [],
)?;
```

Place it after the feature_flags CREATE TABLE block and before the next table definition.

- [ ] **Step 2: Run Rust tests**

Run (from `src-tauri/`): `cargo test`
Expected: PASS — schema migration runs without errors.

- [ ] **Step 3: Run clippy**

Run (from `src-tauri/`): `cargo clippy -- -D warnings`
Expected: PASS — no warnings.

- [ ] **Step 4: Commit**

```bash
git add folio-core/src/db.rs
git commit -m "feat(whats-new): seed whats_new_banner feature flag as enabled"
```

---

### Task 4: `useWhatsNew` Hook

**Files:**
- Create: `src/hooks/useWhatsNew.ts`
- Test: `src/hooks/__tests__/useWhatsNew.test.ts`

- [ ] **Step 1: Write the hook test**

Create `src/hooks/__tests__/useWhatsNew.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWhatsNew } from "../useWhatsNew";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("virtual:release-notes", () => ({
  releaseNotes: [
    {
      version: "2.0.3",
      date: "2026-05-18",
      categories: {
        Added: [{ title: "OPDS feed", description: "New primitives." }],
      },
    },
  ],
  appVersion: "2.0.3",
}));

import { invoke } from "@tauri-apps/api/core";

describe("useWhatsNew", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockResolvedValue(true);
  });

  it("shows banner when flag enabled, not dismissed, and onboarding complete", async () => {
    localStorage.setItem("folio-onboarding-complete", "true");
    const { result } = renderHook(() => useWhatsNew());
    await vi.waitFor(() => expect(result.current.showBanner).toBe(true));
  });

  it("hides banner when already dismissed for current version", async () => {
    localStorage.setItem("folio-onboarding-complete", "true");
    localStorage.setItem("folio-whats-new-dismissed", "2.0.3");
    const { result } = renderHook(() => useWhatsNew());
    await vi.waitFor(() => expect(result.current.flagLoaded).toBe(true));
    expect(result.current.showBanner).toBe(false);
  });

  it("hides banner when onboarding not completed (fresh install)", async () => {
    const { result } = renderHook(() => useWhatsNew());
    await vi.waitFor(() => expect(result.current.flagLoaded).toBe(true));
    expect(result.current.showBanner).toBe(false);
  });

  it("hides banner when feature flag disabled", async () => {
    localStorage.setItem("folio-onboarding-complete", "true");
    vi.mocked(invoke).mockResolvedValue(false);
    const { result } = renderHook(() => useWhatsNew());
    await vi.waitFor(() => expect(result.current.flagLoaded).toBe(true));
    expect(result.current.showBanner).toBe(false);
  });

  it("dismissBanner sets localStorage and hides banner", async () => {
    localStorage.setItem("folio-onboarding-complete", "true");
    const { result } = renderHook(() => useWhatsNew());
    await vi.waitFor(() => expect(result.current.showBanner).toBe(true));
    act(() => result.current.dismissBanner());
    expect(result.current.showBanner).toBe(false);
    expect(localStorage.getItem("folio-whats-new-dismissed")).toBe("2.0.3");
  });

  it("openModal and closeModal toggle showModal", async () => {
    localStorage.setItem("folio-onboarding-complete", "true");
    const { result } = renderHook(() => useWhatsNew());
    await vi.waitFor(() => expect(result.current.flagLoaded).toBe(true));
    expect(result.current.showModal).toBe(false);
    act(() => result.current.openModal());
    expect(result.current.showModal).toBe(true);
    act(() => result.current.closeModal());
    expect(result.current.showModal).toBe(false);
  });

  it("currentRelease matches appVersion", async () => {
    localStorage.setItem("folio-onboarding-complete", "true");
    const { result } = renderHook(() => useWhatsNew());
    await vi.waitFor(() => expect(result.current.currentRelease).not.toBeNull());
    expect(result.current.currentRelease!.version).toBe("2.0.3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/hooks/__tests__/useWhatsNew.test.ts`
Expected: FAIL — `useWhatsNew` does not exist.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useWhatsNew.ts`:

```typescript
import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { releaseNotes, appVersion } from "virtual:release-notes";
import type { ReleaseVersion } from "../../vite-plugin-release-notes";

const DISMISSED_KEY = "folio-whats-new-dismissed";
const ONBOARDING_KEY = "folio-onboarding-complete";

export interface UseWhatsNew {
  showBanner: boolean;
  showModal: boolean;
  openModal: () => void;
  closeModal: () => void;
  dismissBanner: () => void;
  currentRelease: ReleaseVersion | null;
  flagLoaded: boolean;
}

export function useWhatsNew(): UseWhatsNew {
  const [flagEnabled, setFlagEnabled] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === appVersion,
  );
  const [showModal, setShowModal] = useState(false);

  const currentRelease = useMemo(
    () => releaseNotes.find((r) => r.version === appVersion) ?? null,
    [],
  );

  const onboardingComplete = useMemo(
    () => localStorage.getItem(ONBOARDING_KEY) === "true",
    [],
  );

  useEffect(() => {
    invoke<boolean>("get_feature_flag_value", { key: "whats_new_banner" })
      .then(setFlagEnabled)
      .catch(() => setFlagEnabled(false));
  }, []);

  useEffect(() => {
    const unlisten = listen("whats-new-open", () => setShowModal(true));
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const showBanner =
    flagEnabled === true &&
    !dismissed &&
    onboardingComplete &&
    currentRelease !== null;

  const dismissBanner = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, appVersion);
    setDismissed(true);
  }, []);

  const openModal = useCallback(() => setShowModal(true), []);
  const closeModal = useCallback(() => setShowModal(false), []);

  return {
    showBanner,
    showModal,
    openModal,
    closeModal,
    dismissBanner,
    currentRelease,
    flagLoaded: flagEnabled !== null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/hooks/__tests__/useWhatsNew.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useWhatsNew.ts src/hooks/__tests__/useWhatsNew.test.ts
git commit -m "feat(whats-new): add useWhatsNew hook with flag, dismiss, and tray event"
```

---

### Task 5: WhatsNewModal Component

**Files:**
- Create: `src/components/WhatsNewModal.tsx`
- Test: `src/components/__tests__/WhatsNewModal.test.tsx`

- [ ] **Step 1: Write the modal test**

Create `src/components/__tests__/WhatsNewModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import WhatsNewModal from "../WhatsNewModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      const map: Record<string, string> = {
        "whatsNew.modalTitle": `What's New in Folio ${opts?.version ?? ""}`,
        "whatsNew.modalFullChangelog": "See full changelog",
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

const release = {
  version: "2.0.3",
  date: "2026-05-18",
  categories: {
    Added: [
      { title: "OPDS feed primitives", description: "Public primitives for rendering OPDS Atom feeds." },
    ],
    Fixed: [
      { title: "Web server deadlock", description: "The auto-start path held the mutex." },
    ],
  },
};

describe("WhatsNewModal", () => {
  it("renders title with version", () => {
    render(<WhatsNewModal release={release} onClose={() => {}} />);
    expect(screen.getByText("What's New in Folio 2.0.3")).toBeInTheDocument();
  });

  it("renders category headings", () => {
    render(<WhatsNewModal release={release} onClose={() => {}} />);
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("Fixed")).toBeInTheDocument();
  });

  it("renders entry titles", () => {
    render(<WhatsNewModal release={release} onClose={() => {}} />);
    expect(screen.getByText("OPDS feed primitives")).toBeInTheDocument();
    expect(screen.getByText("Web server deadlock")).toBeInTheDocument();
  });

  it("calls onClose when backdrop clicked", () => {
    const onClose = vi.fn();
    render(<WhatsNewModal release={release} onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    const onClose = vi.fn();
    render(<WhatsNewModal release={release} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders full changelog link", () => {
    render(<WhatsNewModal release={release} onClose={() => {}} />);
    expect(screen.getByText("See full changelog")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/__tests__/WhatsNewModal.test.tsx`
Expected: FAIL — `WhatsNewModal` does not exist.

- [ ] **Step 3: Implement the modal**

Create `src/components/WhatsNewModal.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-shell";
import type { ReleaseVersion } from "../../vite-plugin-release-notes";

interface WhatsNewModalProps {
  release: ReleaseVersion;
  onClose: () => void;
}

const CHANGELOG_URL = "https://github.com/mikedamoiseau/folio/blob/main/CHANGELOG.md";

export default function WhatsNewModal({ release, onClose }: WhatsNewModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    const firstBtn = dialogRef.current?.querySelector<HTMLElement>("button");
    firstBtn?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("whatsNew.modalTitle", { version: release.version })}
        className="bg-surface border border-warm-border rounded-2xl shadow-xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-warm-border">
          <div>
            <h2 className="text-lg font-semibold text-ink">
              {t("whatsNew.modalTitle", { version: release.version })}
            </h2>
            <p className="text-sm text-ink-muted mt-0.5">{release.date}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-warm-subtle transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {Object.entries(release.categories).map(([category, entries]) => (
            <div key={category}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
                {category}
              </h3>
              <ul className="space-y-2">
                {entries.map((entry) => (
                  <li key={entry.title} className="text-sm text-ink">
                    <span className="font-medium">{entry.title}</span>
                    {entry.description && (
                      <span className="text-ink-muted"> — {entry.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-warm-border">
          <button
            type="button"
            onClick={() => open(CHANGELOG_URL)}
            className="text-sm text-accent hover:text-accent-hover transition-colors hover:underline"
          >
            {t("whatsNew.modalFullChangelog")} ↗
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/__tests__/WhatsNewModal.test.tsx`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/WhatsNewModal.tsx src/components/__tests__/WhatsNewModal.test.tsx
git commit -m "feat(whats-new): add WhatsNewModal component with category sections"
```

---

### Task 6: WhatsNewBanner Component

**Files:**
- Create: `src/components/WhatsNewBanner.tsx`
- Test: `src/components/__tests__/WhatsNewBanner.test.tsx`

- [ ] **Step 1: Write the banner test**

Create `src/components/__tests__/WhatsNewBanner.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import WhatsNewBanner from "../WhatsNewBanner";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      const map: Record<string, string> = {
        "whatsNew.bannerTitle": `Folio ${opts?.version ?? ""}`,
        "whatsNew.bannerSummary": `${opts?.title ?? ""} and more`,
        "whatsNew.bannerCta": "See what's new",
        "reader.dismiss": "Dismiss",
      };
      return map[key] ?? key;
    },
  }),
}));

describe("WhatsNewBanner", () => {
  const props = {
    version: "2.0.3",
    summary: "OPDS feed primitives",
    onClickCta: vi.fn(),
    onDismiss: vi.fn(),
  };

  it("renders version and summary", () => {
    render(<WhatsNewBanner {...props} />);
    expect(screen.getByText("Folio 2.0.3")).toBeInTheDocument();
    expect(screen.getByText("OPDS feed primitives and more")).toBeInTheDocument();
  });

  it("calls onClickCta when CTA clicked", () => {
    render(<WhatsNewBanner {...props} />);
    fireEvent.click(screen.getByText("See what's new"));
    expect(props.onClickCta).toHaveBeenCalled();
  });

  it("calls onDismiss when dismiss button clicked", () => {
    render(<WhatsNewBanner {...props} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(props.onDismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/__tests__/WhatsNewBanner.test.tsx`
Expected: FAIL — `WhatsNewBanner` does not exist.

- [ ] **Step 3: Implement the banner**

Create `src/components/WhatsNewBanner.tsx`:

```tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/__tests__/WhatsNewBanner.test.tsx`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/WhatsNewBanner.tsx src/components/__tests__/WhatsNewBanner.test.tsx
git commit -m "feat(whats-new): add WhatsNewBanner component"
```

---

### Task 7: Wire Banner + Modal into Library Screen

**Files:**
- Modify: `src/screens/Library.tsx`

- [ ] **Step 1: Add imports to Library.tsx**

At the top of `src/screens/Library.tsx`, add these imports alongside the existing ones:

```typescript
import WhatsNewBanner from "../components/WhatsNewBanner";
import WhatsNewModal from "../components/WhatsNewModal";
import { useWhatsNew } from "../hooks/useWhatsNew";
```

- [ ] **Step 2: Add hook call inside the Library component**

Inside the `Library` function body (near the other hook calls at the top), add:

```typescript
const whatsNew = useWhatsNew();
```

- [ ] **Step 3: Add banner JSX above error toast**

In the Library return JSX, insert the banner **before** the `{/* Error toast */}` comment (before line 977):

```tsx
{whatsNew.showBanner && whatsNew.currentRelease && (
  <WhatsNewBanner
    version={whatsNew.currentRelease.version}
    summary={
      Object.values(whatsNew.currentRelease.categories)[0]?.[0]?.title ?? ""
    }
    onClickCta={whatsNew.openModal}
    onDismiss={whatsNew.dismissBanner}
  />
)}
```

- [ ] **Step 4: Add modal JSX at the end of the component return**

Before the closing `</div>` of the Library root element, add:

```tsx
{whatsNew.showModal && whatsNew.currentRelease && (
  <WhatsNewModal release={whatsNew.currentRelease} onClose={whatsNew.closeModal} />
)}
```

- [ ] **Step 5: Verify type-check passes**

Run: `npm run type-check`
Expected: PASS — no type errors.

- [ ] **Step 6: Run all frontend tests**

Run: `npm run test`
Expected: PASS — no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/screens/Library.tsx
git commit -m "feat(whats-new): wire banner and modal into Library screen"
```

---

### Task 8: Settings Panel — Release Notes Button

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add state and imports**

In `SettingsPanel.tsx`, add imports at the top:

```typescript
import WhatsNewModal from "./WhatsNewModal";
import { releaseNotes, appVersion } from "virtual:release-notes";
```

Inside the `SettingsPanel` component body, add state:

```typescript
const [showReleaseNotes, setShowReleaseNotes] = useState(false);
const currentRelease = releaseNotes.find((r) => r.version === appVersion) ?? null;
```

(The `useState` import already exists in SettingsPanel.)

- [ ] **Step 2: Add Release Notes button in About accordion**

In the About accordion section, after the version paragraph (after line ~2092 where `t("settings.aboutVersion")` is rendered), add:

```tsx
<button
  type="button"
  onClick={() => setShowReleaseNotes(true)}
  disabled={!currentRelease}
  className="text-sm text-accent hover:text-accent-hover transition-colors hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
  title={!currentRelease ? "No release notes for this version" : undefined}
>
  {t("whatsNew.settingsButton")}
</button>
```

- [ ] **Step 3: Add modal render at the end of the component**

Before the final closing `</>` or `</div>` of SettingsPanel, add:

```tsx
{showReleaseNotes && currentRelease && (
  <WhatsNewModal release={currentRelease} onClose={() => setShowReleaseNotes(false)} />
)}
```

- [ ] **Step 4: Verify type-check passes**

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(whats-new): add Release Notes button in Settings About section"
```

---

### Task 9: System Tray — "What's New" Menu Item

**Files:**
- Modify: `src-tauri/src/tray.rs`

- [ ] **Step 1: Add menu item to build_tray_menu()**

In `tray.rs`, inside `build_tray_menu()`, after `show_item` is built (line 16) and before `open_webui` (line 18), add:

```rust
let whats_new = MenuItemBuilder::with_id("whats_new", "What's New").build(app)?;
```

Then in the `MenuBuilder` chain (line 42-50), insert `&whats_new` after `&show_item`:

```rust
MenuBuilder::new(app)
    .item(&show_item)
    .item(&whats_new)
    .item(&open_webui)
    .item(&sep1)
    .item(&web_ui_toggle)
    .item(&opds_toggle)
    .item(&sep2)
    .item(&quit_item)
    .build()
```

- [ ] **Step 2: Add event handler in on_menu_event**

In the `on_menu_event` match block (line 83), add a new arm before the `"quit"` arm:

```rust
"whats_new" => {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("whats-new-open", ());
    } else {
        let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
            .title("Folio")
            .inner_size(800.0, 600.0)
            .build();
        if let Ok(w) = window {
            let _ = w.emit("whats-new-open", ());
        }
    }
}
```

- [ ] **Step 3: Run cargo clippy and cargo test**

Run (from `src-tauri/`):
```bash
cargo clippy -- -D warnings && cargo test
```
Expected: PASS — no warnings, all tests pass.

- [ ] **Step 4: Run cargo fmt check**

Run (from `src-tauri/`): `cargo fmt --check`
Expected: PASS — no formatting issues.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tray.rs
git commit -m "feat(whats-new): add What's New tray menu item with event emission"
```

---

### Task 10: Full Integration Verification

- [ ] **Step 1: Run full CI check suite**

Run from `src-tauri/`:
```bash
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

Run from project root:
```bash
npm run type-check && npm run test
```

Expected: All pass.

- [ ] **Step 2: Manual smoke test**

Run: `npm run tauri dev`

Verify:
1. Library loads with accent banner at top (if version in CHANGELOG matches package.json version — note: current package.json is `2.0.0` and CHANGELOG has `[2.0.0]`, so banner should appear)
2. Click "See what's new" → modal opens with 2.0.0 release notes grouped by Added/Changed/Fixed
3. Close modal → banner still visible
4. Click dismiss ✕ → banner disappears, does not reappear on page reload
5. Open Settings → About → "Release Notes" button visible → click opens modal
6. System tray → "What's New" entry → click brings window to front and opens modal
7. Switch to French (Language button) → banner and modal text in French

- [ ] **Step 3: Verify onboarding guard**

Clear localStorage `folio-onboarding-complete` in dev tools. Reload. Banner should NOT appear. Complete onboarding wizard. Banner should appear after wizard completes (on next mount).

- [ ] **Step 4: Verify feature flag toggle**

In dev tools console, run:
```javascript
window.__TAURI_INTERNALS__.invoke("set_feature_flag", { key: "whats_new_banner", enabled: false })
```
Reload. Banner should not appear. Settings "Release Notes" button should still work.

- [ ] **Step 5: Final commit (if any fixes needed)**

Only if smoke test revealed issues. Otherwise, all work is already committed.
