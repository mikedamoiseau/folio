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
