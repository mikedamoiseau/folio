import { test, expect } from "@playwright/test";

// Regression: on a phone-width viewport, a long unbroken book title (e.g. an
// underscore-heavy filename) used to widen the centered `.detail .info`
// column past the viewport, which pushed the leftmost action button (the
// accent "Continue") off the left edge — clipped off-screen. The `.actions`
// row already had `flex-wrap: wrap`; the real cause was the un-wrapping title.
// Fix: `.detail .info h2 { overflow-wrap: anywhere }` (+ `.info { min-width:0 }`).
//
// `Book 005` (id `e2e-book-005`) is seeded WITH reading progress, so its
// detail page renders the full action set: Continue / Start Over / Download.
const PROGRESS_BOOK_ID = "e2e-book-005";
const LONG_TITLE =
  "Boule et Bill - 45 - Bill_donne_sa_langue_au_chat__33__2025";

test.describe("Detail view — narrow-viewport action row & title wrap", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("long unbroken title wraps and action buttons are never clipped off-screen", async ({
    page,
  }) => {
    await page.goto(`/#/book/${PROGRESS_BOOK_ID}`);
    const continueBtn = page.locator("#continue-btn");
    await continueBtn.waitFor();

    // Force the pathological title into the already-rendered detail heading so
    // the assertion exercises the real shipped CSS rule (not just seed data,
    // whose titles are all short "Book NNN").
    await page.locator(".detail .info h2").evaluate((h2, t) => {
      h2.textContent = t;
    }, LONG_TITLE);

    // Title must wrap within its column, not overflow horizontally.
    const title = page.locator(".detail .info h2");
    const overflows = await title.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1,
    );
    expect(overflows).toBe(false);

    // Every control in the action row must sit fully inside the viewport
    // (leftmost button not clipped off the left edge).
    const width = 390;
    const controls = page.locator(".detail .actions a, .detail .actions button");
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await controls.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
  });
});
