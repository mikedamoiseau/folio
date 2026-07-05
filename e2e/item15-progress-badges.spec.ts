import { test, expect } from "@playwright/test";

// Item 15 — reading-progress badges on grid/shelf cards, run against the
// deterministic harness (src-tauri/examples/web_e2e_server.rs).
//
//   - Grid cards and shelf cards share one progress-bar partial:
//     `.shelf-progress` > `.shelf-progress-fill` (style="width:N%"),
//     rendered by progressBarHtml() and reused by both bookCardHtml() (grid)
//     and shelfCardHtml() (Continue Reading shelf) — there is no separate
//     ".shelf-progress" vs a grid-only class; both surfaces use the exact
//     same DOM/CSS.
//   - A card gets a bar only when total_chapters > 0 AND the resolved
//     chapter index (from the bulk GET /api/reading-progress table) is a
//     number > 0. No bar at all (not even 0%) otherwise.
//   - Fill % is Math.round(((chapter_index + 1) / total_chapters) * 100).
//
// Harness fixture facts (see the example's doc comment for the full layout):
//   - 12 books have chapter_index=4, total_chapters=10 -> exactly 50% fill:
//     Book 005, 015, 025, 035, 045, 055, 065, 075, 085, 095, 105, 115.
//   - Book 060 has total_chapters=0 but a progress row (chapter_index=3) —
//     it must show NO progress bar.
//   - Book 075 (id e2e-book-075) is on page 1 of the default grid AND
//     qualifies for the "Continue Reading" shelf (chapter_index=4 <
//     total_chapters-1=9), so it's the shelf/grid fill-agreement fixture.
const KNOWN_PROGRESS_ID = "e2e-book-005";
const KNOWN_PROGRESS_PCT = 50; // (4 + 1) / 10 * 100
const NO_PROGRESS_ID = "e2e-book-060"; // total_chapters=0, has a progress row
const BOTH_SHELF_AND_GRID_ID = "e2e-book-075";

async function fillPercent(locator: import("@playwright/test").Locator): Promise<number> {
  const width = await locator.evaluate((el) => (el as HTMLElement).style.width);
  return parseInt(width, 10);
}

test.describe("Item 15 — progress badges", () => {
  test("a book with saved progress shows a progress bar with the exact expected fill %", async ({ page }) => {
    await page.goto("/");
    // Search brings the target book into the rendered grid regardless of
    // which page it would otherwise land on.
    await page.fill("#search", "Book 005");
    const card = page.locator(`.grid .card[data-id="${KNOWN_PROGRESS_ID}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    const fill = card.locator(".shelf-progress-fill");
    await expect(fill).toBeVisible();
    const pct = await fillPercent(fill);
    expect(pct).toBe(KNOWN_PROGRESS_PCT);
  });

  test("a book with total_chapters=0 shows no progress bar despite having a progress row", async ({ page }) => {
    await page.goto("/");
    await page.fill("#search", "Book 060");
    const card = page.locator(`.grid .card[data-id="${NO_PROGRESS_ID}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".shelf-progress")).toHaveCount(0);
  });

  test("a book with no progress row at all shows no progress bar", async ({ page }) => {
    // Not e2e-book-130 (the CBZ reader-smoke book): core-smoke.spec.ts
    // opens its reader and that records a progress row as a side effect,
    // so it's no longer a "never touched" book by the time this spec runs.
    await page.goto("/");
    await page.fill("#search", "Book 002");
    const card = page.locator('.grid .card[data-id="e2e-book-002"]');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator(".shelf-progress")).toHaveCount(0);
  });

  test("shelf and grid agree on the fill percentage for the same book", async ({ page }) => {
    await page.goto("/"); // unfiltered home: shows both the shelf and the grid
    const shelfCard = page.locator(`.shelf-card[data-mode="continue"][data-id="${BOTH_SHELF_AND_GRID_ID}"]`);
    const gridCard = page.locator(`.grid .card[data-id="${BOTH_SHELF_AND_GRID_ID}"]`);
    await expect(shelfCard).toBeVisible({ timeout: 10_000 });
    await expect(gridCard).toBeVisible({ timeout: 10_000 });

    const shelfPct = await fillPercent(shelfCard.locator(".shelf-progress-fill"));
    const gridPct = await fillPercent(gridCard.locator(".shelf-progress-fill"));
    expect(shelfPct).toBe(50);
    expect(shelfPct).toBe(gridPct);
  });

  test("grid still fully renders (bar-less) when /api/reading-progress fails", async ({ page }) => {
    await page.route("**/api/reading-progress", (route) => route.abort());
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor({ timeout: 15_000 });

    // Never stuck on skeletons.
    await expect(page.locator(".skeleton-card")).toHaveCount(0);

    const cardCount = await page.locator(".grid .card").count();
    expect(cardCount).toBeGreaterThan(0);

    // Best-effort degrade: no bars anywhere, but the grid itself is intact.
    const barCount = await page.locator(".grid .card .shelf-progress").count();
    expect(barCount).toBe(0);
  });
});
