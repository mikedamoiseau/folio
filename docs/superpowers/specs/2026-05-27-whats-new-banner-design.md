# F-5-1: In-App "What's New" Banner

**Date:** 2026-05-27
**Research ref:** F-5-1 (Tier 1, 3 supporters, M effort, L risk)
**Dependencies:** F-2-6 (Feature Flags) — shipped

## Problem

Users install updates without knowing what changed. CHANGELOG.md exists but is buried in the repo. No in-app surface for release notes.

## Solution

A dismissible banner at the top of the Library screen shown once per version for returning users. Clicking through opens a release notes modal. Persistent access via Settings and system tray.

## Design

### 1. Vite Plugin — `vite-plugin-release-notes.ts`

Virtual module plugin that parses `CHANGELOG.md` at build time. ~50 lines, lives in project root.

**Virtual module ID:** `virtual:release-notes`

**Parse rules:**
- Match `## [version] - date` headers (skip `## [Unreleased]`)
- Match `### Category` subheaders (Added, Fixed, Changed, Performance)
- Extract entry lines starting with `- **Title**` — capture the bold title and the rest as description
- Stop parsing after 3 versions (older entries are not useful for "What's New")

**Output shape:**

```typescript
interface ReleaseEntry {
  title: string;       // bold part: "Split view"
  description: string; // rest of first line, truncated
}

interface ReleaseVersion {
  version: string;     // "2.0.3"
  date: string;        // "2026-05-18"
  categories: Record<string, ReleaseEntry[]>;
}

type ReleaseNotes = ReleaseVersion[];
```

**Type declaration:** `src/vite-env.d.ts` gets a `declare module "virtual:release-notes"` block.

**Current app version** is also exported from the virtual module (read from `package.json` at build time) so the frontend doesn't need a separate Tauri `getVersion()` call for banner logic.

### 2. WhatsNewBanner Component

**File:** `src/components/WhatsNewBanner.tsx`

Full-width accent gradient strip, first element inside the Library screen's root div (above toolbar, line ~977 in Library.tsx).

**Layout:**
- Left: "Folio {version}" bold + one-line summary (first Added entry title, or first entry from any category)
- Right: "See what's new →" link + dismiss ✕ button
- Accent gradient background, white text

**Visibility logic (all must be true):**
1. `whats_new_banner` feature flag is enabled
2. `localStorage.getItem("folio-whats-new-dismissed") !== currentVersion`
3. `localStorage.getItem("folio-onboarding-complete") === "true"` (returning user, not fresh install)
4. Release notes exist for the current version

**Dismiss:** Sets `folio-whats-new-dismissed` to current version in localStorage.

**Click "See what's new":** Opens `WhatsNewModal`.

### 3. WhatsNewModal Component

**File:** `src/components/WhatsNewModal.tsx`

Styled modal (same patterns as `BookDetailModal` / `EditBookDialog`).

**Content:**
- Title: "What's New in Folio {version}"
- Subtitle: release date
- Sections grouped by category (Added, Changed, Fixed, Performance)
- Each entry: bold title + description text
- Footer: "See full changelog" link → opens external browser via Tauri shell `open()` to `https://github.com/mikedamoiseau/folio/blob/main/CHANGELOG.md`

**Triggerable from:**
1. WhatsNewBanner "See what's new" click
2. Settings panel "Release Notes" button
3. System tray "What's New" menu item (via Tauri event)

### 4. Version Tracking & localStorage

| Key | Value | Purpose |
|-----|-------|---------|
| `folio-whats-new-dismissed` | version string (e.g. `"2.0.3"`) | Tracks which version banner was dismissed for |

On app update, the stored version won't match the new version → banner reappears.

### 5. Feature Flag

- **Key:** `whats_new_banner`
- **Default:** enabled
- Seeded in `db.rs::run_schema()` migration: `INSERT OR IGNORE INTO feature_flags (key, enabled, description) VALUES ('whats_new_banner', 1, 'Show What''s New banner on version update')`
- Frontend queries via `invoke("get_feature_flag_value", { key: "whats_new_banner" })` on Library mount
- Disabling the flag hides the banner globally. Settings "Release Notes" button and tray entry remain accessible regardless of flag state.

### 6. Settings Panel Entry

**Location:** About accordion in `SettingsPanel.tsx`, below version display (line ~2092).

**UI:** "Release Notes" text button, same styling as existing links in About section. Opens `WhatsNewModal`.

If no release notes exist for the current version (e.g. development build), button is disabled with tooltip.

### 7. System Tray Entry

**Location:** `tray.rs`, new menu item between "Show Folio" and the separator.

**Label:** "What's New"

**Behavior:** 
1. Bring window to front (same as `show` handler)
2. Emit Tauri event `whats-new-open` to frontend
3. Frontend listens for event → opens `WhatsNewModal`

### 8. i18n Keys

Namespace: `whatsNew`

```json
{
  "whatsNew": {
    "bannerTitle": "Folio {{version}}",
    "bannerSummary": "{{title}} and more",
    "bannerCta": "See what's new",
    "modalTitle": "What's New in Folio {{version}}",
    "modalFullChangelog": "See full changelog",
    "settingsButton": "Release Notes",
    "trayLabel": "What's New"
  }
}
```

Add to both `en.json` and `fr.json`.

### 9. Hook — `useWhatsNew`

**File:** `src/hooks/useWhatsNew.ts`

Encapsulates all banner/modal state:

```typescript
interface UseWhatsNew {
  showBanner: boolean;    // all visibility conditions met
  showModal: boolean;     // modal open state
  openModal: () => void;
  closeModal: () => void;
  dismissBanner: () => void;
  currentRelease: ReleaseVersion | null;
}
```

- Queries feature flag on mount (caches result)
- Reads localStorage for dismissed version
- Checks onboarding completion
- Listens for `whats-new-open` Tauri event (tray trigger)
- Provides stable callbacks for banner and modal

Library.tsx consumes this hook. SettingsPanel imports `openModal` callback (passed via props or a lightweight context).

## Files to Create

| File | Purpose |
|------|---------|
| `vite-plugin-release-notes.ts` | Build-time CHANGELOG parser |
| `src/components/WhatsNewBanner.tsx` | Dismissible top banner |
| `src/components/WhatsNewModal.tsx` | Release notes modal |
| `src/hooks/useWhatsNew.ts` | State management hook |

## Files to Modify

| File | Change |
|------|--------|
| `vite.config.ts` | Import and register plugin |
| `src/vite-env.d.ts` | Add virtual module type declaration |
| `src/screens/Library.tsx` | Add `WhatsNewBanner` above toolbar, consume `useWhatsNew` |
| `src/components/SettingsPanel.tsx` | Add "Release Notes" button in About section |
| `src-tauri/src/tray.rs` | Add "What's New" menu item + event emission |
| `src-tauri/src/db.rs` | Seed `whats_new_banner` feature flag |
| `src/locales/en.json` | Add `whatsNew` namespace |
| `src/locales/fr.json` | Add `whatsNew` namespace (French) |

## Out of Scope

- Translating CHANGELOG content (stays English)
- Version comparison logic (strict equality, not semver comparison)
- Release notes for `[Unreleased]` section
- Web UI "What's New" (desktop only for now)
- Notification badge on tray icon
