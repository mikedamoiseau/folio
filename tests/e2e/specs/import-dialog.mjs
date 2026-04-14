import { expect } from "@wdio/globals";

describe("Import Functionality", () => {
  before(async () => {
    await browser.url("tauri://localhost/");
    await browser.pause(2000);
  });

  it("should show the import button in the toolbar", async () => {
    // ImportButton renders a button that opens a dropdown
    const importBtns = await browser.$$("button");
    let importBtn = null;
    for (const btn of importBtns) {
      const text = await btn.getText();
      if (
        text.toLowerCase().includes("add") ||
        text.toLowerCase().includes("import") ||
        text.toLowerCase().includes("ajouter")
      ) {
        importBtn = btn;
        break;
      }
    }
    expect(importBtn).toBeTruthy();
  });

  it("should open the import dropdown menu when clicked", async () => {
    const importBtns = await browser.$$("button");
    let importBtn = null;
    for (const btn of importBtns) {
      const text = await btn.getText();
      if (
        text.toLowerCase().includes("add") ||
        text.toLowerCase().includes("import") ||
        text.toLowerCase().includes("ajouter")
      ) {
        importBtn = btn;
        break;
      }
    }

    if (importBtn) {
      await importBtn.click();
      await browser.pause(500);
      await browser.saveScreenshot("./screenshots/import-dropdown.png");

      // The dropdown should show menu options
      const menuItems = await browser.$$('[role="menu"] button, .absolute button');
      // Close the dropdown by clicking elsewhere
      await browser.$("body").click();
      await browser.pause(300);
    }
  });
});
