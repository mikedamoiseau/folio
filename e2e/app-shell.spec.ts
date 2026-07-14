import { test, expect } from "@playwright/test";

// Item C (app-feel Tier 1): fixed app shell + kill overscroll.
//
// The web page tell is that the whole document scrolls with browser-default
// overscroll: pulling down past the top fires the native pull-to-refresh
// (which reloads the SPA) and rubber-band scrolling reveals the page edges.
// `overscroll-behavior: none` on the scroll container (html/body for the
// document-scrolled views) removes both. This asserts the computed style so
// a revert to the browser default ("auto") is caught.
test.describe("App shell — overscroll", () => {
  test("document scroll container disables overscroll (no pull-to-refresh)", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    const behavior = await page.evaluate(() => {
      const scroller = document.scrollingElement || document.documentElement;
      return {
        scroller: getComputedStyle(scroller).overscrollBehaviorY,
        body: getComputedStyle(document.body).overscrollBehaviorY,
      };
    });

    // Pull-to-refresh fires from the document's scrolling element (html in
    // standards mode), so that element specifically — not just "one of the
    // two" — must pin overscroll to "none". body is also pinned.
    expect(behavior.scroller).toBe("none");
    expect(behavior.body).toBe("none");
  });
});

// Item A (app-feel Tier 1): bottom tab bar for primary navigation.
//
// On narrow / touch viewports the primary destinations (Library / Collections
// / Stats) move out of the top-right header icon cluster into a fixed
// thumb-reach bottom tab bar; the header's collections/stats icons hide (the
// theme toggle stays). The bar is present on the three top-level views and
// absent in the immersive reader. On desktop the bar is hidden and the header
// cluster is kept.
const TAB_READER_BOOK_ID = "e2e-book-130";

test.describe("App shell — bottom tab bar (narrow)", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("library shows the tab bar with Library active; header nav icons hidden", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    await expect(page.locator(".tab-bar")).toBeVisible();
    await expect(page.locator('.tab-bar .tab[data-tab="library"]')).toHaveClass(/\bactive\b/);

    // The collections/stats icons in the header cluster are hidden on narrow;
    // the theme toggle remains.
    await expect(page.locator('.header .nav-icon[data-nav="stats"]')).toBeHidden();
    await expect(page.locator('.header .nav-icon[data-nav="collections"]')).toBeHidden();
    await expect(page.locator("#theme-toggle-btn")).toBeVisible();
  });

  test("tapping Collections and Stats tabs switches view and active state", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    await page.locator('.tab-bar .tab[data-tab="collections"]').click();
    await expect(page).toHaveURL(/#\/collections$/);
    await expect(page.locator('.tab-bar .tab[data-tab="collections"]')).toHaveClass(/\bactive\b/);

    await page.locator('.tab-bar .tab[data-tab="stats"]').click();
    await expect(page).toHaveURL(/#\/stats$/);
    await expect(page.locator('.tab-bar .tab[data-tab="stats"]')).toHaveClass(/\bactive\b/);

    await page.locator('.tab-bar .tab[data-tab="library"]').click();
    await expect(page).toHaveURL(/#\/?$|#\/library/);
    await expect(page.locator('.tab-bar .tab[data-tab="library"]')).toHaveClass(/\bactive\b/);
  });

  test("tab bar is absent in the immersive reader", async ({ page }) => {
    await page.goto(`/#/book/${TAB_READER_BOOK_ID}`);
    const readBtn = page.locator("#read-btn");
    const restartBtn = page.locator("#restart-btn");
    await expect(readBtn.or(restartBtn)).toBeVisible({ timeout: 15_000 });
    if (await readBtn.count()) {
      await readBtn.click();
    } else {
      await restartBtn.click();
    }
    await page.locator("#reader-stage").waitFor();
    await expect(page.locator(".tab-bar")).toHaveCount(0);
  });
});

test.describe("App shell — bottom tab bar (desktop)", () => {
  test("tab bar is hidden and the header nav icons are kept at desktop width", async ({ page }) => {
    // Default project viewport is 1280×720 (desktop, fine pointer).
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    await expect(page.locator(".tab-bar")).toBeHidden();
    await expect(page.locator('.header .nav-icon[data-nav="stats"]')).toBeVisible();
    await expect(page.locator('.header .nav-icon[data-nav="collections"]')).toBeVisible();
  });
});
