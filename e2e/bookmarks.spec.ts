import { test, expect, Page } from "@playwright/test";

const EPUB_ID = "e2e-book-050";
test.use({ serviceWorkers: "block" });

async function openEpubReader(page: Page) {
  await page.goto(`/#/book/${EPUB_ID}/0/read`);
  const restart = page.locator("#resume-restart-btn");
  const content = page.locator("#reader-content");
  await expect(restart.or(content)).toBeVisible({ timeout: 15_000 });
  if (await restart.isVisible()) { await restart.click(); await content.waitFor(); }
  await expect(content).toContainText("chapter zero", { timeout: 10_000 });
}

// Bookmarks persist to the harness's shared on-disk DB (seeded once at server
// start, not reset per test). Clear this book's bookmarks before each test so
// counts start from a clean slate regardless of what earlier tests created.
test.beforeEach(async ({ request }) => {
  const resp = await request.get(`/api/books/${EPUB_ID}/bookmarks`);
  if (!resp.ok()) return;
  const rows = await resp.json();
  for (const bm of rows) {
    await request.delete(`/api/books/${EPUB_ID}/bookmarks/${bm.id}`);
  }
});

test.describe("web reader bookmarks — core", () => {
  test("toolbar shows a bookmark trigger", async ({ page }) => {
    await openEpubReader(page);
    await expect(page.locator("#bookmark-btn")).toBeVisible();
  });

  test("empty state before any bookmark", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#bookmark-btn").click();
    await expect(page.locator("#bookmark-panel")).toBeVisible();
    await expect(page.locator(".bookmark-empty")).toContainText("No bookmarks yet");
  });

  test("add-here creates an entry the list shows", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#bookmark-btn").click();
    await page.locator("#bookmark-add-btn").click();
    await expect(page.locator(".bookmark-entry")).toHaveCount(1);
  });

  test("tap a different-chapter bookmark jumps and closes the panel", async ({ page }) => {
    await openEpubReader(page);
    // Bookmark chapter 0, turn to chapter 1, then jump back via the bookmark.
    await page.locator("#bookmark-btn").click();
    await page.locator("#bookmark-add-btn").click();
    await expect(page.locator(".bookmark-entry")).toHaveCount(1);
    await page.locator("#bookmark-close").click();
    await page.locator("#next-btn").click();
    await expect(page.locator("#reader-content")).toContainText("chapter one");
    await page.locator("#bookmark-btn").click();
    await page.locator(".bookmark-entry").first().click();
    await expect(page.locator("#reader-content")).toContainText("chapter zero");
    await expect(page.locator("#bookmark-panel")).toBeHidden();
  });

  test("delete removes the entry", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#bookmark-btn").click();
    await page.locator("#bookmark-add-btn").click();
    await expect(page.locator(".bookmark-entry")).toHaveCount(1);
    await page.locator(".bookmark-del").first().click();
    await expect(page.locator(".bookmark-entry")).toHaveCount(0);
    await expect(page.locator(".bookmark-empty")).toBeVisible();
  });
});

test.describe("web reader bookmarks — dismissal", () => {
  test("Escape closes without navigating back", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#bookmark-btn").click();
    await expect(page.locator("#bookmark-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#bookmark-panel")).toBeHidden();
    await expect(page.locator("#reader-content")).toBeVisible();
  });

  test("click outside closes, click inside keeps open", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#bookmark-btn").click();
    await page.locator("#bookmark-panel").click({ position: { x: 10, y: 10 } });
    await expect(page.locator("#bookmark-panel")).toBeVisible();
    await page.locator("#reader-stage").click({ position: { x: 600, y: 300 } });
    await expect(page.locator("#bookmark-panel")).toBeHidden();
  });

  test("opening Contents/Aa closes Bookmarks and vice-versa", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#bookmark-btn").click();
    await expect(page.locator("#bookmark-panel")).toBeVisible();
    await page.locator("#typo-btn").click();
    await expect(page.locator("#typo-panel")).toBeVisible();
    await expect(page.locator("#bookmark-panel")).toBeHidden();
    await page.locator("#bookmark-btn").click();
    await expect(page.locator("#bookmark-panel")).toBeVisible();
    await expect(page.locator("#typo-panel")).toBeHidden();
  });

  test("chrome-hide closes it and it stays closed on chrome return", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#bookmark-btn").click();
    await expect(page.locator("#bookmark-panel")).toBeVisible();
    await page.locator("#chrome-toggle-btn").click();
    await expect(page.locator("#bookmark-panel")).toBeHidden();
    await page.locator("#chrome-toggle-btn").click();
    await expect(page.locator("#bookmark-panel")).toBeHidden();
    await expect(page.locator("#bookmark-btn")).toHaveAttribute("aria-expanded", "false");
  });

  test("arrow keys don't turn the chapter while the panel is open", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#bookmark-btn").click();
    await page.locator("#bookmark-panel").press("ArrowRight");
    await expect(page.locator("#reader-content")).toContainText("chapter zero");
    await expect(page.locator("#bookmark-panel")).toBeVisible();
  });
});
