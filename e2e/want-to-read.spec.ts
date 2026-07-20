import { test, expect } from "@playwright/test";

// "Want to read" flag — web UI (Milestone 4), run against the deterministic
// harness (src-tauri/examples/web_e2e_server.rs).
//
// Design (await-then-set, deviating from the plan's optimistic override-map,
// per the M3 lesson): the detail-view toggle AWAITs the PUT and only then
// flips its state; grid cards, the filter, and the shelf render straight from
// fetched server data. Returning to the library re-fetches, so everything
// converges to server truth with no client-side override machinery.
//
// Harness fixture facts:
//   - Book 042 (e2e-book-042) is seeded with want_to_read = true — the baseline
//     member of the filter/shelf/badge on a fresh load.
//   - The harness seeds no collections and no series, so this file also exercises
//     "the filter bar renders its toggle even with nothing else to filter".
//   - The DB persists across the whole (workers=1) run, so beforeEach normalizes
//     the two books this file mutates to a known state via the write API.
const FLAGGED_ID = "e2e-book-042"; // seeded flagged
const TOGGLE_ID = "e2e-book-130"; // starts unflagged; the detail-toggle fixture

// Scopes to the "Want to read" home shelf specifically — Book 130 also appears
// on the "Recently Added" shelf, so a bare `.shelf-card[data-id=...]` would be
// ambiguous.
function wantShelf(page: import("@playwright/test").Page) {
  return page
    .locator(".shelf-section")
    .filter({ has: page.getByRole("heading", { name: "Want to read", exact: true }) });
}

test.describe.serial("Want to read — web UI", () => {
  test.beforeEach(async ({ page }) => {
    // Deterministic starting state regardless of prior-test mutations.
    await page.request.put(`/api/books/${FLAGGED_ID}/want-to-read`, { data: { want_to_read: true } });
    await page.request.put(`/api/books/${TOGGLE_ID}/want-to-read`, { data: { want_to_read: false } });
  });

  test("the filter bar renders its Want-to-read toggle even with no series/collections", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#filter-want-btn")).toBeVisible();
    // The harness seeds neither collections nor series.
    await expect(page.locator("#collection-dropdown-btn")).toHaveCount(0);
    await expect(page.locator("#series-dropdown-btn")).toHaveCount(0);
  });

  test("activating the filter narrows the grid to flagged books; All Books clears it", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#filter-want-btn")).toBeVisible();
    await page.locator(".grid .card").first().waitFor();

    await page.click("#filter-want-btn");
    await expect(page).toHaveURL(/want_to_read=true/);
    await expect(page.locator("#filter-want-btn")).toHaveClass(/active/);

    // Only the one seeded-flagged book remains.
    await expect(page.locator(`.grid .card[data-id="${FLAGGED_ID}"]`)).toBeVisible();
    await expect(page.locator(".grid .card")).toHaveCount(1);

    // "All Books" clears the filter and restores the full grid.
    await page.click("#filter-reset-btn");
    await expect(page).not.toHaveURL(/want_to_read=true/);
    await expect(page.locator("#filter-want-btn")).not.toHaveClass(/active/);
    await expect(page.locator(".grid .card").nth(1)).toBeVisible();
  });

  test("toggling from the detail view adds the badge, filter, and shelf membership on return", async ({ page }) => {
    await page.goto(`/#/book/${TOGGLE_ID}`);
    const wantBtn = page.locator("#want-btn");
    await expect(wantBtn).toHaveAttribute("aria-pressed", "false");

    // await-then-set: aria-pressed only flips once the PUT resolves ok.
    await wantBtn.click();
    await expect(wantBtn).toHaveAttribute("aria-pressed", "true");

    // Read-only 🔖 badge on the grid card (search brings it into view).
    await page.goto("/");
    await page.fill("#search", "Book 130");
    const card = page.locator(`.grid .card[data-id="${TOGGLE_ID}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".want-badge")).toBeVisible();

    // Filter membership.
    await page.goto("/#/library?want_to_read=true");
    await expect(page.locator(`.grid .card[data-id="${TOGGLE_ID}"]`)).toBeVisible();

    // Shelf membership on the unfiltered home view.
    await page.goto("/");
    await expect(wantShelf(page).locator(`.shelf-card[data-id="${TOGGLE_ID}"]`)).toBeVisible({ timeout: 10_000 });
  });

  test("the shelf shows on the unfiltered home and hides under a search/filter", async ({ page }) => {
    await page.goto("/");
    // Baseline seeded-flagged book is on the shelf.
    await expect(wantShelf(page).locator(`.shelf-card[data-id="${FLAGGED_ID}"]`)).toBeVisible({ timeout: 10_000 });

    // A search hides every shelf (filtered view).
    await page.fill("#search", "Book 042");
    await expect(page.locator(`.grid .card[data-id="${FLAGGED_ID}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".shelf-section")).toHaveCount(0);

    // The active Want-to-read filter also hides the shelves.
    await page.goto("/#/library?want_to_read=true");
    await expect(page.locator(`.grid .card[data-id="${FLAGGED_ID}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".shelf-section")).toHaveCount(0);
  });

  test("opening a book then Back lands on the full unfiltered home (filter cleared)", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#filter-want-btn")).toBeVisible();
    await page.locator(".grid .card").first().waitFor();

    // Activate the filter, then open the one flagged book.
    await page.click("#filter-want-btn");
    await expect(page).toHaveURL(/want_to_read=true/);
    await page.click(`.grid .card[data-id="${FLAGGED_ID}"]`);
    await expect(page.locator("#want-btn")).toBeVisible();

    // The detail back button is goHome() — a full reset, not a return to the
    // filtered grid.
    await page.click("#back-btn");
    await expect(page).not.toHaveURL(/want_to_read=true/);
    await expect(page.locator("#filter-want-btn")).not.toHaveClass(/active/);
    // Shelves are back (guarded on the unfiltered state).
    await expect(wantShelf(page).locator(`.shelf-card[data-id="${FLAGGED_ID}"]`)).toBeVisible({ timeout: 10_000 });
  });

  test("an empty want-to-read grid shows the dedicated empty-state message", async ({ page }) => {
    // Clear the only seeded-flagged book so the filter matches nothing.
    await page.request.put(`/api/books/${FLAGGED_ID}/want-to-read`, { data: { want_to_read: false } });
    await page.goto("/#/library?want_to_read=true");
    await expect(page.locator(".grid .card")).toHaveCount(0);
    await expect(page.locator("#library-content .empty")).toContainText("Want to read");
  });

  test("back/forward restores the filter state", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#filter-want-btn")).toBeVisible();
    await page.locator(".grid .card").first().waitFor();

    await page.click("#filter-want-btn");
    await expect(page).toHaveURL(/want_to_read=true/);
    await expect(page.locator("#filter-want-btn")).toHaveClass(/active/);

    await page.goBack();
    await expect(page).not.toHaveURL(/want_to_read=true/);
    await expect(page.locator("#filter-want-btn")).not.toHaveClass(/active/);

    await page.goForward();
    await expect(page).toHaveURL(/want_to_read=true/);
    await expect(page.locator("#filter-want-btn")).toHaveClass(/active/);
  });
});
