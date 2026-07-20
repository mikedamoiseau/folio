import { expect, type Page } from "@playwright/test";

// The book-detail action row is a primary "Read"/"Continue" button plus a
// "More" (⋯) overflow menu holding Start Over / Save offline / Download. These
// helpers drive that menu so specs written against the old flat row keep
// working after the redesign.

// Open the detail-view "More" overflow menu (idempotent — a no-op if already
// open). Leaves the menu open.
export async function openDetailMenu(page: Page) {
  const menu = page.locator("#detail-menu");
  if (!(await menu.isVisible())) {
    await page.locator("#detail-more-btn").click();
  }
  await expect(menu).toBeVisible();
}

// Enter the reader at the very start (chapter/page index 0). Uses the
// always-visible primary "Read" when the book has no progress; otherwise opens
// the More menu and picks "Start Over" (both land on index 0). This keeps
// reader specs idempotent across re-runs on the shared harness, where a prior
// entry recorded progress and flipped "Read" into "Continue".
export async function enterReaderAtStart(page: Page) {
  const readBtn = page.locator("#read-btn");
  await expect(readBtn.or(page.locator("#continue-btn"))).toBeVisible({
    timeout: 15_000,
  });
  if (await readBtn.count()) {
    await readBtn.click();
  } else {
    await openDetailMenu(page);
    await page.locator("#restart-btn").click();
  }
}
