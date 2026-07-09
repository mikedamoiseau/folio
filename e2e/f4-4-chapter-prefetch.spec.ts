import { test, expect } from "@playwright/test";

// F-4-4 — the embedded web reader prefetches the NEXT chapter's HTML (and its
// inline image URLs) into an in-memory cache as soon as the current chapter
// renders, so a forward turn renders synchronously from cache instead of
// doing an on-demand network round-trip.
//
// Harness fixture (src-tauri/examples/web_e2e_server.rs `build_test_epub`):
// Book 050 (id `e2e-book-050`) is the only EPUB with a real file on disk — 2
// chapters, and chapter index 1 embeds one inline <img>. It's the sole
// reflowable book whose `/api/books/:id/chapters/:index` route returns real
// HTML, and it sits outside every count/ordering/progress assertion.
const EPUB_ID = "e2e-book-050";
const chapterPath = (index: number) => `/api/books/${EPUB_ID}/chapters/${index}`;

// Opens the chapter reader at chapter 0, dismissing a resume prompt (progress
// can persist when a local run reuses the harness) so we deterministically
// land on chapter 0.
async function openChapterZero(page: import("@playwright/test").Page) {
  await page.goto(`/#/book/${EPUB_ID}/0/read`);
  const restart = page.locator("#resume-restart-btn");
  const content = page.locator("#reader-content");
  await expect(restart.or(content)).toBeVisible({ timeout: 15_000 });
  if (await restart.isVisible()) {
    await restart.click();
    await content.waitFor();
  }
  await expect(content).toContainText("chapter zero", { timeout: 10_000 });
}

test.describe("F-4-4 — web reader next-chapter prefetch", () => {
  test("opening chapter 0 proactively fetches chapter 1 without navigating", async ({ page }) => {
    const nextChapter = page.waitForResponse(
      (resp) =>
        new URL(resp.url()).pathname === chapterPath(1) && resp.request().method() === "GET",
      { timeout: 15_000 }
    );

    await openChapterZero(page);

    // The next chapter is fetched proactively — with no user navigation.
    const resp = await nextChapter;
    expect(resp.ok()).toBeTruthy();
    // We never turned the page: the URL is still chapter 0.
    await expect(page).toHaveURL(new RegExp(`#/book/${EPUB_ID}/0/read`));
  });

  test("prefetch also warms the next chapter's inline image URLs", async ({ page }) => {
    const imageReq = page.waitForRequest(
      (req) => new URL(req.url()).pathname.startsWith(`/api/books/${EPUB_ID}/images/1/`),
      { timeout: 15_000 }
    );

    await openChapterZero(page);

    // Warming the prefetched chapter's <img> issues a request for its image,
    // again without any navigation into chapter 1.
    const req = await imageReq;
    expect(req.url()).toContain(`/api/books/${EPUB_ID}/images/1/`);
    await expect(page).toHaveURL(new RegExp(`#/book/${EPUB_ID}/0/read`));
  });

  test("turning forward renders chapter 1 from cache with no second fetch", async ({ page }) => {
    // Register the prefetch listener before navigating so we can't miss it.
    const prefetch = page.waitForResponse(
      (resp) => new URL(resp.url()).pathname === chapterPath(1),
      { timeout: 15_000 }
    );

    await openChapterZero(page);
    await prefetch; // chapter 1 is now cached

    // From here on, any network fetch for chapter 1 would mean a cache miss.
    let ch1Fetches = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === chapterPath(1)) ch1Fetches += 1;
    });

    await page.locator("#reader-stage").focus();
    await page.keyboard.press("ArrowRight");

    await expect(page).toHaveURL(new RegExp(`#/book/${EPUB_ID}/1/read`), { timeout: 10_000 });
    await expect(page.locator("#reader-content")).toContainText("chapter one");

    // Give any (unexpected) on-demand fetch a chance to fire, then assert the
    // turn was served entirely from the prefetch cache.
    await page.waitForTimeout(300);
    expect(ch1Fetches).toBe(0);
  });
});
