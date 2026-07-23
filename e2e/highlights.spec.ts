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

// Chapter-0 rendered text contains: "Fish & chips 🦀 the quick brown fox …"
// Compute offsets of a substring within the rendered chapter text at runtime
// so the seed matches reality (UTF-16 code units, textContent basis).
async function chapterOffsetsOf(page: Page, needle: string) {
  return page.evaluate((needle) => {
    const el = document.querySelector("#reader-content")!;
    const text = el.textContent!;
    const s = text.indexOf(needle);
    return { s, e: s + needle.length };
  }, needle);
}

async function seedHighlight(page: Page, needle: string, color = "#f6c445") {
  const { s, e } = await chapterOffsetsOf(page, needle);
  expect(s).toBeGreaterThan(-1);
  const resp = await page.request.post(`/api/books/${EPUB_ID}/highlights`, {
    data: { chapterIndex: 0, text: needle, color, startOffset: s, endOffset: e },
  });
  expect(resp.status()).toBe(201);
  return resp.json();
}

test.beforeEach(async ({ request }) => {
  const resp = await request.get(`/api/books/${EPUB_ID}/highlights`);
  if (!resp.ok()) return;
  for (const hl of await resp.json()) {
    await request.delete(`/api/books/${EPUB_ID}/highlights/${hl.id}`);
  }
});

test.describe("highlight rendering", () => {
  test("stored highlight renders as a mark after entity and emoji", async ({ page }) => {
    await openEpubReader(page);
    // Region AFTER "&" (1 rendered char vs 5 raw chars) and AFTER 🦀 (2 code
    // units) — proves textContent/UTF-16 basis, the desktop injector's bug.
    await seedHighlight(page, "quick brown fox");
    await page.reload();
    await openEpubReader(page);
    const mark = page.locator("#reader-content mark.hl-mark");
    await expect(mark.first()).toBeVisible();
    await expect(mark.first()).toHaveText("quick brown fox");
  });

  test("drift fallback re-anchors by quoted text", async ({ page }) => {
    await openEpubReader(page);
    const { s, e } = await chapterOffsetsOf(page, "lazy dog");
    // Deliberately wrong offsets (shifted +7), correct quote text.
    const resp = await page.request.post(`/api/books/${EPUB_ID}/highlights`, {
      data: { chapterIndex: 0, text: "lazy dog", color: "#f6c445",
              startOffset: s + 7, endOffset: e + 7 },
    });
    expect(resp.status()).toBe(201);
    await page.reload();
    await openEpubReader(page);
    await expect(page.locator("#reader-content mark.hl-mark").first())
      .toHaveText("lazy dog");
  });

  test("crossing overlaps nest and innermost is deterministic", async ({ page }) => {
    await openEpubReader(page);
    // A = "brown fox jumps", B = "fox jumps over" — B starts inside A and
    // ends after it (crossing, not containment).
    const a = await seedHighlight(page, "brown fox jumps", "#f6c445");
    const b = await seedHighlight(page, "fox jumps over", "#6ba3d6");
    await page.reload();
    await openEpubReader(page);
    // Shared region "fox jumps" sits inside marks of BOTH ids.
    const shared = page.locator(
      `#reader-content mark[data-hl-id="${b.id}"] >> text=fox jumps`).first();
    await expect(shared).toBeVisible();
    const nestedIds = await page.evaluate(() => {
      const inner = [...document.querySelectorAll("#reader-content mark.hl-mark mark.hl-mark")];
      return inner.map((m) => (m as HTMLElement).dataset.hlId);
    });
    expect(nestedIds.length).toBeGreaterThan(0);
  });

  test("marks survive chapter turn away and back", async ({ page }) => {
    await openEpubReader(page);
    await seedHighlight(page, "quick brown fox");
    await page.reload();
    await openEpubReader(page);
    await expect(page.locator("mark.hl-mark").first()).toBeVisible();
    await page.locator("#next-btn").click();
    await expect(page.locator("#reader-content")).toContainText("chapter one");
    await expect(page.locator("mark.hl-mark")).toHaveCount(0); // chapter 1 has none
    await page.locator("#prev-btn").click();
    await expect(page.locator("#reader-content")).toContainText("chapter zero");
    await expect(page.locator("mark.hl-mark").first()).toBeVisible();
  });
});
