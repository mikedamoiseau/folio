import { test, expect } from "@playwright/test";

// Item 14 — infinite-scroll pagination on the "All Books" grid, run against
// the deterministic harness (src-tauri/examples/web_e2e_server.rs).
//
// Harness fixture facts used below (see the example's doc comment for the
// full layout):
//   - 130 books total, ids `e2e-book-001`..`e2e-book-130`, `added_at`
//     increasing with the numeric suffix -> default sort
//     (`ORDER BY added_at DESC, id`) is Book 130 first, Book 001 last.
//   - Page size is 60 (LIBRARY_PAGE_SIZE in app.js), so:
//       page 1 (offset 0)   = Book 130 .. Book 071 (60 books)
//       page 2 (offset 60)  = Book 070 .. Book 011 (60 books)
//       page 3 (offset 120) = Book 010 .. Book 001 (10 books)
//   - Book 099 and Book 100 share an identical `added_at`, so the `id` ASC
//     tiebreaker puts `e2e-book-099` immediately before `e2e-book-100` in
//     the default sort, even though 100 > 99.
//   - Searching "Book 12" matches exactly Book 120..Book 129 (10 books) —
//     "Book 012" doesn't match ("Book 12" isn't a substring of "Book 012").
const TOTAL_BOOKS = 130;
const PAGE_SIZE = 60;

test.describe("Item 14 — pagination", () => {
  test("home grid renders exactly one bounded page, not the whole library", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();
    const count = await page.locator(".grid .card").count();
    expect(count).toBe(PAGE_SIZE);
    expect(count).toBeLessThan(TOTAL_BOOKS);
  });

  test("the /api/books request carries limit=60/offset=0 and X-Total-Count: 130", async ({ page }) => {
    // app.js's init() does an unauthenticated *probe* fetch to the bare
    // `/api/books` (no query string) before routing to the library — the
    // predicate below must skip that probe and match only the real,
    // paginated grid fetch (which always carries an `offset` param).
    const [response] = await Promise.all([
      page.waitForResponse(
        (resp) =>
          new URL(resp.url()).pathname === "/api/books" &&
          new URL(resp.url()).searchParams.has("offset") &&
          resp.request().method() === "GET"
      ),
      page.goto("/"),
    ]);
    const url = new URL(response.url());
    expect(url.searchParams.get("limit")).toBe(String(PAGE_SIZE));
    expect(url.searchParams.get("offset")).toBe("0");
    expect(response.headers()["x-total-count"]).toBe(String(TOTAL_BOOKS));
  });

  test("default sort order: Book 130 first, Book 099 immediately before Book 100 (id tiebreak), Book 071 last on page 1", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();
    const ids = await page
      .locator(".grid .card")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-id")));
    expect(ids).toHaveLength(PAGE_SIZE);
    expect(ids[0]).toBe("e2e-book-130");
    expect(ids[ids.length - 1]).toBe("e2e-book-071");

    const idx99 = ids.indexOf("e2e-book-099");
    const idx100 = ids.indexOf("e2e-book-100");
    expect(idx99).toBeGreaterThanOrEqual(0);
    expect(idx100).toBe(idx99 + 1);
  });

  test("scrolling to the bottom loads page 2 (offset 60) with no duplicate ids", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();
    const initialCount = await page.locator(".grid .card").count();
    expect(initialCount).toBe(PAGE_SIZE);

    const nextPage = page.waitForResponse(
      (resp) =>
        new URL(resp.url()).pathname === "/api/books" &&
        new URL(resp.url()).searchParams.get("offset") === String(PAGE_SIZE)
    );
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await nextPage;

    await expect
      .poll(async () => page.locator(".grid .card").count(), { timeout: 10_000 })
      .toBe(PAGE_SIZE * 2);

    const ids = await page.locator(".grid .card").evaluateAll((els) => els.map((el) => el.getAttribute("data-id")));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[ids.length - 1]).toBe("e2e-book-011");
  });

  test("typing a search query resets to a fresh offset=0 page of exactly the 10 matching results", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    const searchResponse = page.waitForResponse(
      (resp) =>
        new URL(resp.url()).pathname === "/api/books" &&
        new URL(resp.url()).searchParams.get("q") === "Book 12" &&
        new URL(resp.url()).searchParams.get("offset") === "0"
    );
    await page.fill("#search", "Book 12");
    const resp = await searchResponse;
    expect(resp.ok()).toBeTruthy();

    await expect.poll(async () => page.locator(".grid .card").count()).toBe(10);
    const titles = await page.locator(".grid .card .title").allTextContents();
    expect(new Set(titles)).toEqual(
      new Set(["Book 120", "Book 121", "Book 122", "Book 123", "Book 124", "Book 125", "Book 126", "Book 127", "Book 128", "Book 129"])
    );

    // Clearing returns to the unfiltered, paginated grid.
    const clearResponse = page.waitForResponse(
      (resp) =>
        new URL(resp.url()).pathname === "/api/books" &&
        !new URL(resp.url()).searchParams.get("q") &&
        new URL(resp.url()).searchParams.get("offset") === "0"
    );
    await page.fill("#search", "");
    await clearResponse;
    await expect.poll(async () => page.locator(".grid .card").count()).toBe(PAGE_SIZE);
  });

  test("back navigation from a scrolled position roughly restores scroll offset", async ({ page }) => {
    await page.goto("/");
    await page.locator(".grid .card").first().waitFor();

    await page.evaluate(() => window.scrollTo(0, 1400));
    await page.waitForTimeout(200); // let the scroll settle
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);

    // Click programmatically (not via Playwright's .click(), which would
    // auto-scroll the element into view and clobber the position we're
    // trying to test the restoration of).
    await page.evaluate(() => {
      const card = document.querySelector(".grid .card") as HTMLElement | null;
      card?.click();
    });
    await page.locator("#back-btn").waitFor();

    await page.click("#back-btn");
    await page.locator(".grid .card").first().waitFor();
    await expect.poll(async () => page.evaluate(() => window.scrollY), { timeout: 10_000 }).toBeGreaterThan(0);

    const scrollAfter = await page.evaluate(() => window.scrollY);
    // Generous tolerance: scroll restore replays pages and re-lays-out the
    // grid, so pixel-perfect equality isn't the contract — "roughly back
    // where we were" is.
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(600);
  });
});
