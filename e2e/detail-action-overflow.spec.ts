import { test, expect } from "@playwright/test";
import { openDetailMenu } from "./detail-actions";

// The book-detail action row is a single always-visible primary button
// ("Continue" with progress, "Read" without) plus a "More" (⋯) overflow menu
// holding the rest (Start Over / Save offline / Download) as icon+label rows.
// This replaced the old flat button row, whose leftmost button could be pushed
// off-screen at phone width. The title-wrap regression (a long unbroken title
// widening the column) is still covered here too.
//
// `Book 005` (id `e2e-book-005`) is seeded WITH reading progress, so its detail
// page renders Continue (primary) + Start Over / Save offline / Download (menu).
const PROGRESS_BOOK_ID = "e2e-book-005";
const LONG_TITLE =
  "Boule et Bill - 45 - Bill_donne_sa_langue_au_chat__33__2025";

const VIEWPORT_WIDTH = 390;

// No element may extend past either edge of the viewport.
async function assertNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const docScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  expect(docScroll).toBe(true);
}

test.describe("Detail view — narrow-viewport primary + More menu", () => {
  test.use({ viewport: { width: VIEWPORT_WIDTH, height: 800 } });

  test("primary button is visible and never clipped; a long title wraps", async ({
    page,
  }) => {
    await page.goto(`/#/book/${PROGRESS_BOOK_ID}`);
    const primary = page.locator("#continue-btn");
    await primary.waitFor();

    // Force the pathological title into the rendered heading so the assertion
    // exercises the real shipped CSS rule (seed titles are all short).
    await page.locator(".detail .info h2").evaluate((h2, t) => {
      h2.textContent = t;
    }, LONG_TITLE);

    // Title wraps within its column, not overflowing horizontally.
    const title = page.locator(".detail .info h2");
    const titleOverflows = await title.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1,
    );
    expect(titleOverflows).toBe(false);

    // The always-visible primary + the More button both sit fully inside the
    // viewport (the leftmost control is not clipped off the left edge).
    for (const sel of ["#continue-btn", "#detail-more-btn"]) {
      const box = await page.locator(sel).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORT_WIDTH + 1);
    }
    await assertNoHorizontalOverflow(page);
  });

  test("the More menu reveals Start Over / Save offline / Download, all on-screen", async ({
    page,
  }) => {
    await page.goto(`/#/book/${PROGRESS_BOOK_ID}`);
    await page.locator("#detail-more-btn").waitFor();

    // Menu is closed initially.
    await expect(page.locator("#detail-menu")).toBeHidden();

    await openDetailMenu(page);
    const restart = page.locator("#restart-btn");
    const download = page.locator(".detail-menu a[href*='/download']");
    // Progress book → Start Over is present; Download is always present.
    await expect(restart).toBeVisible();
    await expect(download).toBeVisible();
    // Save offline is offered on this secure-context (localhost) run.
    await expect(page.locator("#offline-save-btn")).toBeVisible();

    // Every revealed menu item sits fully inside the viewport.
    const items = page.locator(".detail-menu .detail-menu-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await items.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORT_WIDTH + 1);
    }
    await assertNoHorizontalOverflow(page);
  });

  test("the More menu closes on outside-tap and on Escape", async ({ page }) => {
    await page.goto(`/#/book/${PROGRESS_BOOK_ID}`);
    await page.locator("#detail-more-btn").waitFor();
    const menu = page.locator("#detail-menu");
    const moreBtn = page.locator("#detail-more-btn");

    // Outside-tap dismisses.
    await openDetailMenu(page);
    await expect(moreBtn).toHaveAttribute("aria-expanded", "true");
    await page.locator(".detail .info h2").click();
    await expect(menu).toBeHidden();
    await expect(moreBtn).toHaveAttribute("aria-expanded", "false");

    // Escape dismisses.
    await openDetailMenu(page);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(moreBtn).toHaveAttribute("aria-expanded", "false");
  });
});
