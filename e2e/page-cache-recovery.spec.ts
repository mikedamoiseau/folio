import { test, expect, type Page } from "@playwright/test";

// Reader page-image cache recovery. A poisoned browser HTTP cache entry (a
// bad/truncated 200 for /api/books/:id/pages/:index) re-serves broken bytes
// to every <img> load of that URL, so the page stays broken on revisit.
// handlePageImageError must, on the first failure, re-request the page with a
// cache-busting query param so the browser fetches fresh bytes from the
// server instead of the bad cached copy — recovering without ever showing the
// error box. If that retry also fails, the error box is the honest fallback.
//
// The poisoned cache is modelled by route interception: a request to the bare
// URL is aborted (what a broken cached entry looks like to the <img>), while
// the cache-busted retry URL (…?__reload=N) — a distinct cache key that would
// reach the network for real — is let through to the server.
//
// Offline mode made the service worker intercept /api/books/{id}/... GETs
// (network-first). Requests issued by an SW-controlled page bypass
// page.route(), which would silently defeat the abort-based poisoning above —
// so this spec runs with service workers blocked. That matches its premise:
// it tests the browser HTTP cache + app.js retry logic, not the SW.
test.use({ serviceWorkers: "block" });

const READER_BOOK_ID = "e2e-book-130";

// Matches …/pages/1 exactly (not /pages/10, /pages/11), with or without a query.
const PAGE_1_RE = /\/api\/books\/[^/]+\/pages\/1(?:\?|$)/;

async function openCbzReader(page: Page) {
  await page.goto(`/#/book/${READER_BOOK_ID}`);
  const readBtn = page.locator("#read-btn");
  const restartBtn = page.locator("#restart-btn");
  await expect(readBtn.or(restartBtn)).toBeVisible({ timeout: 15_000 });
  if (await readBtn.count()) {
    await readBtn.click();
  } else {
    await restartBtn.click();
  }
  await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/0/read`));
  const pageImg = page.locator("#page-img");
  await expect(pageImg).toBeVisible();
  await expect
    .poll(async () => pageImg.evaluate((img) => (img as HTMLImageElement).naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);
}

test.describe("Reader page-image cache recovery", () => {
  test("a broken cached page image recovers via a cache-bypassing reload", async ({ page }) => {
    let bareAborts = 0;
    let recoveryLoads = 0;
    // Model a poisoned cache: requests to the bare page-1 URL fail (both the
    // neighbor preload and the display image), but the cache-busted retry URL
    // (…?__reload=N) is let through — a distinct cache key that reaches the
    // server for real.
    await page.route(PAGE_1_RE, async (route) => {
      if (route.request().url().includes("__reload")) {
        recoveryLoads++;
        await route.continue();
      } else {
        bareAborts++;
        await route.abort();
      }
    });

    await openCbzReader(page);
    await page.keyboard.press("ArrowRight"); // -> page 1: display <img> aborts
    await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/1/read`), { timeout: 10_000 });

    const pageImg = page.locator("#page-img");
    // Recovery: the image ends up loaded (from the cache-busted URL) and the
    // error box is never shown.
    await expect
      .poll(async () => pageImg.evaluate((img) => (img as HTMLImageElement).naturalWidth), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expect(page.locator("#page-error")).toBeHidden();
    const src = await pageImg.evaluate((img) => (img as HTMLImageElement).src);
    expect(src).toContain("__reload=");

    // The mechanism was actually exercised, not sidestepped: at least one bare
    // load failed and the cache-busted retry ran.
    expect(bareAborts).toBeGreaterThan(0);
    expect(recoveryLoads).toBeGreaterThan(0);
  });

  test("the error box shows when the recovery reload also fails", async ({ page }) => {
    // Both the <img> loads and the recovery fetch fail — genuine dead page.
    await page.route(PAGE_1_RE, (route) => route.abort());

    await openCbzReader(page);
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/1/read`), { timeout: 10_000 });

    await expect(page.locator("#page-error")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#page-error")).toHaveText(/Couldn't load this page/);
  });
});
