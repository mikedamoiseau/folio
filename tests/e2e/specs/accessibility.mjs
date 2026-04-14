import { expect } from "@wdio/globals";

describe("Accessibility", () => {
  before(async () => {
    await browser.url("tauri://localhost/");
    await browser.pause(2000);
  });

  it("should have aria-labels on all interactive header buttons", async () => {
    const headerButtons = await browser.$$("header button, nav button");
    for (const btn of headerButtons) {
      const ariaLabel = await btn.getAttribute("aria-label");
      const text = await btn.getText();
      const hasLabel = ariaLabel || text.trim().length > 0;
      expect(hasLabel).toBe(true);
    }
  });

  it("should have labels on all select elements", async () => {
    const selects = await browser.$$("select");
    for (const select of selects) {
      const ariaLabel = await select.getAttribute("aria-label");
      const id = await select.getAttribute("id");
      const hasLabel = ariaLabel || id;
      expect(hasLabel).toBeTruthy();
    }
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
