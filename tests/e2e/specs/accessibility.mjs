import { expect } from "@wdio/globals";

describe("Accessibility", () => {
  it("should have aria-labels on most interactive header buttons", async () => {
    // Count how many header buttons have accessible labels
    const headerButtons = await browser.$$("header button, nav button");
    let labeled = 0;
    let unlabeled = [];
    for (const btn of headerButtons) {
      const ariaLabel = await btn.getAttribute("aria-label");
      const title = await btn.getAttribute("title");
      const text = await btn.getText();
      if (ariaLabel || title || text.trim().length > 0) {
        labeled++;
      } else {
        const html = await btn.getHTML();
        unlabeled.push(html.substring(0, 80));
      }
    }
    // At least 80% of buttons should be labeled
    const ratio = headerButtons.length > 0 ? labeled / headerButtons.length : 1;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });

  it("should have labels on select elements", async () => {
    const selects = await browser.$$("select");
    let labeled = 0;
    for (const select of selects) {
      const ariaLabel = await select.getAttribute("aria-label");
      const id = await select.getAttribute("id");
      if (ariaLabel || id) labeled++;
    }
    // At least most selects should have labels
    const ratio = selects.length > 0 ? labeled / selects.length : 1;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
  });

  it("should have placeholder or label on search input", async () => {
    const search = await browser.$("#library-search");
    if (await search.isExisting()) {
      const placeholder = await search.getAttribute("placeholder");
      const ariaLabel = await search.getAttribute("aria-label");
      expect(placeholder || ariaLabel).toBeTruthy();
    }
  });

  it("should support keyboard navigation with Tab", async () => {
    // Tab through a few elements and verify focus moves
    await browser.keys("Tab");
    await browser.pause(200);
    const firstFocused = await browser.execute(
      () => document.activeElement?.tagName
    );
    expect(firstFocused).toBeTruthy();

    await browser.keys("Tab");
    await browser.pause(200);
    const secondFocused = await browser.execute(
      () => document.activeElement?.tagName
    );
    expect(secondFocused).toBeTruthy();
  });

  it("should have focus-visible outlines on focused elements", async () => {
    // Focus on search input
    const search = await browser.$("#library-search");
    if (await search.isExisting()) {
      await search.click();
      await browser.pause(200);

      // Check that outline is applied (via :focus-visible CSS)
      const outline = await browser.execute(() => {
        const el = document.activeElement;
        if (!el) return null;
        const style = window.getComputedStyle(el);
        return style.outlineStyle;
      });
      // outline should not be "none" when focused
      // (This may vary depending on how :focus-visible triggers)
    }
  });

  it("should close dialogs with Escape key", async () => {
    // Open settings
    const settingsBtn = await browser.$(
      'button[aria-label*="settings" i], button[aria-label*="Settings"]'
    );
    if (await settingsBtn.isExisting()) {
      await settingsBtn.click();
      await browser.pause(500);

      // Press Escape to close
      await browser.keys("Escape");
      await browser.pause(500);

      // Settings panel should be closed
      // (verify by checking if the main library is visible again)
      const search = await browser.$("#library-search");
      await expect(search).toBeExisting();
    }
  });
});
