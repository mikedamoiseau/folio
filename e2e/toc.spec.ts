import { test, expect, Page } from "@playwright/test";

// Table-of-contents chapter navigation in the web reader. Exercises the
// deterministic harness. Book 050 (`e2e-book-050`) is the only on-disk EPUB;
// its fixture (web_e2e_server.rs) carries a nav document with three flat
// entries: "Chapter Zero" (idx 0), "Chapter One" (idx 1), "Section 1.1"
// (idx 1 — its `#sec` fragment is stripped server-side).
const EPUB_ID = "e2e-book-050";

// These tests intercept /chapters with page.route. The reader's service
// worker (registered on the localhost secure context) would otherwise serve
// or relay those requests itself, invisibly to page.route — block it so
// interception and mocked responses actually apply.
test.use({ serviceWorkers: "block" });

// Open Book 050's chapter reader at chapter 0, dismissing a resume prompt so we
// deterministically land on chapter 0 (prior tests may leave saved progress).
async function openEpubReader(page: Page) {
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

test.describe("web reader TOC — data", () => {
  test("reader fetches the chapter TOC once, not on every turn", async ({ page }) => {
    let calls = 0;
    await page.route(`**/api/books/${EPUB_ID}/chapters`, (route) => {
      calls++;
      route.continue();
    });
    await openEpubReader(page);
    // Open may render at most twice (initial + resume-prompt restart); a
    // chapter TURN must add no further fetch.
    const afterOpen = calls;
    expect(afterOpen).toBeGreaterThanOrEqual(1);
    expect(afterOpen).toBeLessThanOrEqual(2);
    await page.locator("#next-btn").click();
    await expect(page.locator("#reader-content")).toContainText("chapter one");
    expect(calls).toBe(afterOpen);
  });
});

test.describe("web reader TOC — trigger", () => {
  test("chapter mode shows an interactive Contents trigger, no slider", async ({ page }) => {
    await openEpubReader(page);
    await expect(page.locator("#page-slider")).toHaveCount(0);
    const btn = page.locator("#toc-btn");
    await expect(btn).toBeVisible();
    await expect(btn).toContainText("Chapter 1 / 2");
  });
});

test.describe("web reader TOC — panel", () => {
  test("opening lists entries with real labels; tap jumps and closes", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#toc-btn").click();
    const panel = page.locator("#toc-panel");
    await expect(panel).toBeVisible();
    const entries = panel.locator(".toc-entry");
    await expect(entries).toHaveCount(3);
    expect(await entries.allInnerTexts()).toEqual([
      "Chapter Zero",
      "Chapter One",
      "Section 1.1",
    ]);
    await entries.nth(1).click();
    await expect(page.locator("#reader-content")).toContainText("chapter one");
    await expect(panel).toBeHidden();
  });

  test("current chapter highlighted — both entries at that index", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#next-btn").click();
    await expect(page.locator("#reader-content")).toContainText("chapter one");
    await page.locator("#toc-btn").click();
    await expect(page.locator(".toc-entry.current")).toHaveCount(2);
    await expect(
      page.locator(".toc-entry", { hasText: "Chapter Zero" })
    ).not.toHaveClass(/current/);
  });

  test("progress still advances after a TOC-driven jump", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#toc-btn").click();
    await page.locator(".toc-entry", { hasText: "Chapter One" }).click();
    await expect(page.locator("#reader-content")).toContainText("chapter one");
    await expect(page.locator("#page-label")).toContainText("Chapter 2 / 2");
  });

  // Each case must leave tocStatus "none" → a plain, non-interactive label.
  // Separate tests (fresh context each) so the browser's HTTP cache for
  // /chapters can't carry one case's response into the next.
  const degenerate: Array<{ name: string; status?: number; body: string }> = [
    { name: "single entry", body: JSON.stringify([{ label: "Only", chapter_index: 0, play_order: "1", children: [] }]) },
    { name: "empty list", body: JSON.stringify([]) },
    { name: "non-array JSON", body: JSON.stringify({}) },
    {
      name: "index out of range",
      body: JSON.stringify([
        { label: "A", chapter_index: 0, play_order: "1", children: [] },
        { label: "B", chapter_index: 99, play_order: "2", children: [] },
      ]),
    },
    { name: "server error", status: 500, body: "boom" },
  ];
  for (const c of degenerate) {
    test(`degeneracy: ${c.name} renders a plain label`, async ({ page }) => {
      let hits = 0;
      await page.route(`**/api/books/${EPUB_ID}/chapters`, (r) => {
        hits++;
        r.fulfill({ status: c.status ?? 200, contentType: "application/json", body: c.body });
      });
      await openEpubReader(page);
      // Prove the mocked TOC was actually consumed (not just the initial
      // loading fallback) before asserting the trigger stayed plain.
      await expect.poll(() => hits).toBeGreaterThan(0);
      await expect(page.locator("#toc-btn")).toHaveCount(0);
      await expect(page.locator(".toc-plain")).toBeVisible();
    });
  }
});

test.describe("web reader TOC — accessibility & dismissal", () => {
  test("Escape closes the panel without navigating back", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#toc-btn").click();
    await expect(page.locator("#toc-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#toc-panel")).toBeHidden();
    // Still in the reader, not navigated back to the detail/library view.
    await expect(page.locator("#reader-content")).toBeVisible();
  });

  test("clicking outside the panel closes it", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#toc-btn").click();
    await expect(page.locator("#toc-panel")).toBeVisible();
    // A click inside the panel must NOT dismiss it.
    await page.locator("#toc-panel").click({ position: { x: 10, y: 10 } });
    await expect(page.locator("#toc-panel")).toBeVisible();
    // Click well to the right of the ~320px left drawer, so the click lands
    // outside the panel — that dismisses.
    await page.locator("#reader-stage").click({ position: { x: 600, y: 300 } });
    await expect(page.locator("#toc-panel")).toBeHidden();
  });

  test("Prev/Next keeps the panel open and re-syncs the highlight", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#toc-btn").click();
    await expect(page.locator("#toc-panel")).toBeVisible();
    await page.locator("#next-btn").click();
    // Wait for the turn to complete, then assert the panel stayed open and the
    // current-chapter highlight advanced to index 1 (Chapter One + Section 1.1
    // both map to it).
    await expect(page.locator("#reader-content")).toContainText("chapter one");
    await expect(page.locator("#toc-panel")).toBeVisible();
    await expect(page.locator(".toc-entry.current")).toHaveCount(2);
  });

  test("opening one bottom-chrome panel closes the other", async ({ page }) => {
    await openEpubReader(page);
    // Open Aa, then Contents — only Contents should remain open.
    await page.locator("#typo-btn").click();
    await expect(page.locator("#typo-panel")).toBeVisible();
    await page.locator("#toc-btn").click();
    await expect(page.locator("#toc-panel")).toBeVisible();
    await expect(page.locator("#typo-panel")).toBeHidden();
    // And the reverse.
    await page.locator("#typo-btn").click();
    await expect(page.locator("#typo-panel")).toBeVisible();
    await expect(page.locator("#toc-panel")).toBeHidden();
  });

  test("hiding the chrome closes the panel and it stays closed when shown again", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#toc-btn").click();
    await expect(page.locator("#toc-panel")).toBeVisible();
    await page.locator("#chrome-toggle-btn").click();
    await expect(page.locator("#toc-panel")).toBeHidden();
    // Showing the chrome again must NOT re-reveal the panel (state was cleared,
    // not just visually masked by the hidden chrome row).
    await page.locator("#chrome-toggle-btn").click();
    await expect(page.locator("#toc-panel")).toBeHidden();
    await expect(page.locator("#toc-btn")).toHaveAttribute("aria-expanded", "false");
  });

  test("arrow keys don't turn the chapter while the panel is open", async ({ page }) => {
    await openEpubReader(page);
    await page.locator("#toc-btn").click();
    await page.locator("#toc-panel").press("ArrowRight");
    await expect(page.locator("#reader-content")).toContainText("chapter zero");
    await expect(page.locator("#toc-panel")).toBeVisible();
  });
});
