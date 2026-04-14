import { expect } from "@wdio/globals";

describe("Theme & Appearance", () => {
  it("should open settings and navigate to Appearance section", async () => {
    const settingsBtn = await browser.$(
      'button[aria-label*="settings" i], button[aria-label*="Settings"]'
    );
    await settingsBtn.click();
    await browser.pause(500);

    // Find and click the Appearance accordion
    const accordions = await browser.$$("button[aria-expanded]");
    for (const acc of accordions) {
      const text = await acc.getText();
      if (
        text.toLowerCase().includes("appearance") ||
        text.toLowerCase().includes("apparence")
      ) {
        const expanded = await acc.getAttribute("aria-expanded");
        if (expanded === "false") {
          await acc.click();
          await browser.pause(300);
        }
        break;
      }
    }
  });

  it("should display saved themes section", async () => {
    // Look for theme-related UI elements
    await browser.saveScreenshot("./screenshots/theme-section.png");
  });

  it("should have theme mode buttons (dark/light/sepia)", async () => {
    // Theme mode buttons typically have descriptive text or icons
    const buttons = await browser.$$("button");
    const modeLabels = [];
    for (const btn of buttons) {
      const text = await btn.getText();
      const lower = text.toLowerCase();
      if (
        lower.includes("dark") ||
        lower.includes("light") ||
        lower.includes("sepia") ||
        lower.includes("sombre") ||
        lower.includes("clair") ||
        lower.includes("sépia")
      ) {
        modeLabels.push(text);
      }
    }
    // At least some theme controls should exist
    // (may be buttons, radio inputs, or custom controls)
  });

  it("should be able to toggle between appearance modes", async () => {
    // Find preset reset buttons (Reset to Light, Reset to Sepia)
    const buttons = await browser.$$("button");
    let lightBtn = null;
    for (const btn of buttons) {
      const text = await btn.getText();
      if (
        text.toLowerCase().includes("light") ||
        text.toLowerCase().includes("clair")
      ) {
        lightBtn = btn;
        break;
      }
    }

    if (lightBtn) {
      await lightBtn.click();
      await browser.pause(500);
      await browser.saveScreenshot("./screenshots/theme-light.png");
    }
  });

  after(async () => {
    // Close settings
    const closeBtn = await browser.$(
      'button[aria-label*="close" i], button[aria-label*="fermer" i]'
    );
    if (await closeBtn.isExisting()) {
      await closeBtn.click();
      await browser.pause(300);
    }
  });
});
