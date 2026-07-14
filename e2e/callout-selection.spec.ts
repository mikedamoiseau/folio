import { test, expect } from "@playwright/test";

// Item F (app-feel Tier 2): suppress the long-press callout / stray selection
// on chrome, so it doesn't behave like a web document.
//
// Chrome (header, bottom tab bar, cards, toolbar) gets user-select: none +
// -webkit-touch-callout: none; reading content (chapter text, book
// description) keeps selection. -webkit-touch-callout is Safari-only and not
// exposed in headless Chromium, so it is guarded at the CSS source
// (mod.rs); user-select IS computed, so assert it here on the chrome.
test.describe("Callout/selection — chrome is unselectable (narrow)", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("header, tab bar and cards suppress text selection", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    const sel = await page.evaluate(() => {
      const us = (el: Element | null) =>
        el ? getComputedStyle(el).userSelect || (getComputedStyle(el) as any).webkitUserSelect : null;
      return {
        header: us(document.querySelector(".header")),
        tabBar: us(document.querySelector(".tab-bar")),
        card: us(document.querySelector(".grid .card")),
      };
    });

    expect(sel.header).toBe("none");
    expect(sel.tabBar).toBe("none");
    expect(sel.card).toBe("none");
  });

  test("the header search input stays selectable (not disabled by chrome)", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    // #search sits inside .header, which sets user-select:none; a direct rule
    // on inputs must re-enable it so typed text can still be selected/edited.
    const us = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.header input[type="search"]');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return cs.userSelect || (cs as any).webkitUserSelect;
    });
    expect(us).toBe("text");
  });
});
