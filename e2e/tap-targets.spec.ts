import { test, expect } from "@playwright/test";

// Item E (app-feel Tier 2): 44px minimum tap targets.
//
// On touch, the small interactive chrome (nav icons, the sort <select>, filter
// buttons, reader-toolbar buttons) sat well under the 44x44 finger-target
// floor. On narrow/touch viewports these grow to >=44px in at least one axis
// (icons in both) via min-height/min-width; the visual palette/type is
// unchanged. Desktop (wide, fine pointer) keeps the compact sizes.
const MIN = 44;
const READER_BOOK_ID = "e2e-book-130";

test.describe("Tap targets — 44px floor (narrow)", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("header nav icon and sort select meet the 44px floor", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    // The theme toggle is the one .nav-icon that stays in the header on narrow
    // (the data-nav icons move to the tab bar). Icon-only → 44 in both axes.
    const toggle = page.locator("#theme-toggle-btn");
    const tb = await toggle.boundingBox();
    expect(tb).not.toBeNull();
    expect(tb!.width).toBeGreaterThanOrEqual(MIN);
    expect(tb!.height).toBeGreaterThanOrEqual(MIN);

    // The library sort <select> → at least 44px tall.
    const sel = page.locator(".header select").first();
    const sb = await sel.boundingBox();
    expect(sb).not.toBeNull();
    expect(sb!.height).toBeGreaterThanOrEqual(MIN);
  });

  test("reader toolbar buttons meet the 44px floor", async ({ page }) => {
    await page.goto(`/#/book/${READER_BOOK_ID}`);
    const readBtn = page.locator("#read-btn");
    const restartBtn = page.locator("#restart-btn");
    await expect(readBtn.or(restartBtn)).toBeVisible({ timeout: 15_000 });
    if (await readBtn.count()) {
      await readBtn.click();
    } else {
      await restartBtn.click();
    }
    await page.locator("#reader-stage").waitFor();

    const btn = page.locator(".reader-toolbar button").first();
    const bb = await btn.boundingBox();
    expect(bb).not.toBeNull();
    expect(bb!.height).toBeGreaterThanOrEqual(MIN);
  });
});

test.describe("Tap targets — coarse pointer, wide viewport", () => {
  // The gate is `max-width: 600px, (hover: none) and (pointer: coarse)`. A
  // coarse-pointer tablet in landscape (>600px) never matches the width clause,
  // so it relies solely on the pointer clause. Emulate a mobile (coarse,
  // hover:none) context at 900px to exercise that clause specifically — the
  // narrow tests above only cover the width clause.
  test.use({ viewport: { width: 900, height: 600 }, hasTouch: true, isMobile: true });

  test("nav icon meets the 44px floor via the coarse-pointer clause", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    const toggle = page.locator("#theme-toggle-btn");
    const tb = await toggle.boundingBox();
    expect(tb).not.toBeNull();
    expect(tb!.width).toBeGreaterThanOrEqual(MIN);
    expect(tb!.height).toBeGreaterThanOrEqual(MIN);
  });
});

test.describe("Tap targets — desktop stays compact", () => {
  test("nav icon is not enlarged at desktop width", async ({ page }) => {
    // Default project viewport is desktop (fine pointer): the 44px floor must
    // not apply, so the header cluster is not visibly bulkier than before.
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    const toggle = page.locator("#theme-toggle-btn");
    const tb = await toggle.boundingBox();
    expect(tb).not.toBeNull();
    expect(tb!.height).toBeLessThan(MIN);
  });
});
