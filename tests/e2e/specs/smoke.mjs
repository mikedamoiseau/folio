import { expect } from "@wdio/globals";

describe("Folio App - Smoke Test", () => {
  it("should launch and show the correct window title", async () => {
    const title = await browser.getTitle();
    expect(title).toBe("Folio");
  });

  it("should render the app container", async () => {
    const app = await browser.$("#app");
    await expect(app).toBeExisting();
  });

  it("should display the Folio logo/link in navigation", async () => {
    const logo = await browser.$('a[href="/"]');
    await logo.waitForExist({ timeout: 10000 });
    const text = await logo.getText();
    expect(text).toContain("Folio");
  });

  it("should show the settings button in the header", async () => {
    const settingsBtn = await browser.$('button[aria-label="Open settings"]');
    await expect(settingsBtn).toBeExisting();
  });

  it("should take a launch screenshot", async () => {
    await browser.saveScreenshot("./screenshots/launch.png");
  });
});
