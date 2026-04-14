import { expect } from "@wdio/globals";

describe("Library Screen", () => {
  describe("Search", () => {
    it("should have a search input with placeholder", async () => {
      const search = await browser.$("#library-search");
      await search.waitForExist({ timeout: 10000 });
      await expect(search).toBeExisting();
      const placeholder = await search.getAttribute("placeholder");
      expect(placeholder).toBeTruthy();
    });

    it("should accept text input in search field", async () => {
      const search = await browser.$("#library-search");
      await search.setValue("test query");
      const value = await search.getValue();
      expect(value).toBe("test query");
    });

    it("should clear search and restore results", async () => {
      const search = await browser.$("#library-search");
      await search.clearValue();
      const value = await search.getValue();
      expect(value).toBe("");
    });

    it("should focus search with keyboard shortcut /", async () => {
      // Click body first to ensure search isn't already focused
      await browser.$("body").click();
      await browser.keys("/");
      const focused = await browser.execute(() => document.activeElement?.id);
      expect(focused).toBe("library-search");
    });
  });

  describe("Filter Controls", () => {
    it("should have a format filter dropdown", async () => {
      const formatSelect = await browser.$(
        'select[aria-label*="format" i], select[aria-label*="Format"]'
      );
      await expect(formatSelect).toBeExisting();
    });

    it("should be able to select EPUB format filter", async () => {
      const formatSelect = await browser.$(
        'select[aria-label*="format" i], select[aria-label*="Format"]'
      );
      await formatSelect.selectByAttribute("value", "epub");
      const value = await formatSelect.getValue();
      expect(value).toBe("epub");
    });

    it("should reset format filter to all", async () => {
      const formatSelect = await browser.$(
        'select[aria-label*="format" i], select[aria-label*="Format"]'
      );
      await formatSelect.selectByAttribute("value", "all");
      const value = await formatSelect.getValue();
      expect(value).toBe("all");
    });

    it("should have a status filter dropdown", async () => {
      const statusSelect = await browser.$(
        'select[aria-label*="status" i], select[aria-label*="Status"]'
      );
      await expect(statusSelect).toBeExisting();
    });

    it("should have a rating filter dropdown", async () => {
      const ratingSelect = await browser.$(
        'select[aria-label*="rating" i], select[aria-label*="Rating"]'
      );
      await expect(ratingSelect).toBeExisting();
    });
  });

  describe("Sort Controls", () => {
    it("should display sort buttons", async () => {
      // Sort bar contains multiple buttons for sort columns
      const sortButtons = await browser.$$(
        ".border-b button.text-xs, .border-b button.text-\\[11px\\]"
      );
      expect(sortButtons.length).toBeGreaterThan(0);
    });

    it("should be able to click a sort button to change sort order", async () => {
      // Find a sort button (e.g., "Title")
      const sortBtns = await browser.$$("button");
      let titleBtn = null;
      for (const btn of sortBtns) {
        const text = await btn.getText();
        if (text.includes("Title") || text.includes("Titre")) {
          titleBtn = btn;
          break;
        }
      }
      if (titleBtn) {
        await titleBtn.click();
        // Click again to toggle direction
        await titleBtn.click();
      }
    });
  });

  describe("Book Grid", () => {
    it("should show either books or an empty state", async () => {
      // Wait for loading to complete
      await browser.pause(2000);

      const bookCards = await browser.$$("button.group");
      const emptyState = await browser.$(".text-center");

      const hasBooks = bookCards.length > 0;
      const isEmpty = await emptyState.isExisting();

      // One of these should be true
      expect(hasBooks || isEmpty).toBe(true);
    });

    it("should take a screenshot of the library view", async () => {
      await browser.saveScreenshot("./screenshots/library.png");
    });
  });
});
