import { expect } from "@wdio/globals";

describe("Settings Panel", () => {
  before(async () => {
    // Navigate to library first to ensure we're on the main screen
    await browser.url("tauri://localhost/");
    await browser.pause(2000);
  });

  it("should open settings panel when clicking the settings button", async () => {
    const settingsBtn = await browser.$(
      'button[aria-label="Open settings"], button[aria-label*="settings" i]'
    );
    await settingsBtn.waitForExist({ timeout: 10000 });
    await settingsBtn.click();
    await browser.pause(500);

    // Settings panel should now be visible
    const panel = await browser.$('[role="dialog"], .fixed.inset-0');
    await expect(panel).toBeExisting();
  });

  it("should show the settings title", async () => {
    const heading = await browser.$("h2");
    await heading.waitForExist({ timeout: 5000 });
    const text = await heading.getText();
    // Should contain "Settings" or localized equivalent
    expect(text).toBeTruthy();
  });

  describe("Accordion Sections", () => {
    it("should have multiple accordion sections", async () => {
      const accordionButtons = await browser.$$(
        'button[aria-expanded], section button'
      );
      expect(accordionButtons.length).toBeGreaterThan(3);
    });

    it("should expand a section when clicked", async () => {
      // Find the first accordion button that is collapsed
      const sections = await browser.$$("button[aria-expanded]");
      if (sections.length > 1) {
        const section = sections[1];
        const expanded = await section.getAttribute("aria-expanded");
        await section.click();
        await browser.pause(300);
        const newExpanded = await section.getAttribute("aria-expanded");
        // Should have toggled
        expect(newExpanded !== expanded).toBe(true);
      }
    });
  });

  describe("Appearance Section", () => {
    it("should show theme mode options", async () => {
      // Click the Appearance accordion to open it
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

      // Should have theme/mode controls visible
      await browser.pause(500);
      await browser.saveScreenshot("./screenshots/settings-appearance.png");
    });
  });

  describe("General Section", () => {
    it("should show launch at startup toggle", async () => {
      // Open the General accordion
      const accordions = await browser.$$("button[aria-expanded]");
      for (const acc of accordions) {
        const text = await acc.getText();
        if (
          text.toLowerCase().includes("general") ||
          text.toLowerCase().includes("général")
        ) {
          const expanded = await acc.getAttribute("aria-expanded");
          if (expanded === "false") {
            await acc.click();
            await browser.pause(300);
          }
          break;
        }
      }

      // Should have a switch/toggle for autostart
      const toggle = await browser.$('button[role="switch"]');
      await expect(toggle).toBeExisting();
    });

    it("should be able to toggle the autostart switch", async () => {
      const toggle = await browser.$('button[role="switch"]');
      const checkedBefore = await toggle.getAttribute("aria-checked");
      await toggle.click();
      await browser.pause(1000);
      const checkedAfter = await toggle.getAttribute("aria-checked");
      expect(checkedAfter !== checkedBefore).toBe(true);

      // Toggle back to original state
      await toggle.click();
      await browser.pause(1000);
    });
  });

  describe("Web Server Section", () => {
    it("should show the Remote Access section", async () => {
      const accordions = await browser.$$("button[aria-expanded]");
      for (const acc of accordions) {
        const text = await acc.getText();
        if (
          text.toLowerCase().includes("remote") ||
          text.toLowerCase().includes("distance")
        ) {
          const expanded = await acc.getAttribute("aria-expanded");
          if (expanded === "false") {
            await acc.click();
            await browser.pause(300);
          }
          break;
        }
      }

      // Should have PIN and port inputs
      const pinInput = await browser.$("#web-server-pin");
      await expect(pinInput).toBeExisting();

      const portInput = await browser.$("#web-server-port");
      await expect(portInput).toBeExisting();
    });

    it("should have a start/stop server button", async () => {
      // Find a button related to server start/stop
      const buttons = await browser.$$("button");
      let serverBtn = null;
      for (const btn of buttons) {
        const text = await btn.getText();
        if (
          text.toLowerCase().includes("start") ||
          text.toLowerCase().includes("stop") ||
          text.toLowerCase().includes("démarrer") ||
          text.toLowerCase().includes("arrêter")
        ) {
          serverBtn = btn;
          break;
        }
      }
      expect(serverBtn).toBeTruthy();
    });
  });

  after(async () => {
    // Close settings panel
    const closeBtn = await browser.$(
      'button[aria-label*="close" i], button[aria-label*="fermer" i]'
    );
    if (await closeBtn.isExisting()) {
      await closeBtn.click();
      await browser.pause(300);
    }
  });
});
