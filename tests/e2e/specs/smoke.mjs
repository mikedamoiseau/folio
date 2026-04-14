import { expect } from "@wdio/globals";

describe("Folio App - Smoke Test", () => {
  it("should launch and show the main window", async () => {
    const title = await browser.getTitle();
    expect(title).toBe("Folio");
  });

  it("should have a visible app container", async () => {
    const app = await browser.$("#app");
    await expect(app).toBeExisting();
  });

  it("should show the library header", async () => {
    // Wait for the app to load — the header contains "Folio"
    const header = await browser.$("h1");
    await header.waitForExist({ timeout: 10000 });
    const text = await header.getText();
    expect(text).toContain("Folio");
  });

  it("should have a search input", async () => {
    const search = await browser.$('input[type="search"]');
    await expect(search).toBeExisting();
  });

  it("should take a screenshot", async () => {
    const screenshot = await browser.saveScreenshot("./screenshots/smoke.png");
    expect(screenshot).toBeTruthy();
  });
});
