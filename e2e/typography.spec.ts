import { test, expect, type Page } from "@playwright/test";

// Web reader typography controls (M2/M3). The settings model, live apply, and
// reflow-preservation are exercised against the real client (app.js) on the
// deterministic harness. Book 050 (`e2e-book-050`) is the only on-disk EPUB —
// 2 chapters, ch1 lengthened to ~60 paragraphs so `#reader-stage` scrolls.
const EPUB_ID = "e2e-book-050";

// app.js is an IIFE; the typography surface is exposed on `window.__folioTypo`
// for these tests: { validate, get, set, change }.
type TypoHook = {
  validate: (raw: unknown) => Record<string, unknown>;
  get: () => Record<string, unknown>;
  set: (patch: Record<string, unknown>) => Record<string, unknown>;
  change: (patch: Record<string, unknown>) => void;
};

async function gotoLibrary(page: Page) {
  await page.goto("/");
  await page.locator(".grid .card").first().waitFor({ timeout: 15_000 });
}

// Open Book 050's chapter reader at chapter 0, dismissing a resume prompt so we
// deterministically land on chapter 0 with `#reader-content` populated.
async function openEpubChapter(page: Page) {
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

// Inline style of #reader-content (typography is applied as inline styles, not
// a stylesheet rule — read el.style directly rather than getComputedStyle).
async function readerContentStyle(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector("#reader-content") as HTMLElement;
    return {
      fontSize: el.style.fontSize,
      lineHeight: el.style.lineHeight,
      maxWidth: el.style.maxWidth,
      fontFamily: el.style.fontFamily,
    };
  });
}

// The typography test hook (window.__folioTypo) is gated in app.js behind this
// flag, set before load, so the internal API never ships to the production
// reader. Registered before every test's navigation.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __folioExposeTypoHook: boolean }).__folioExposeTypoHook = true;
  });
});

test.describe("Web reader typography — settings model", () => {
  test("validateTypography clamps then snaps", async ({ page }) => {
    await gotoLibrary(page);
    const out = await page.evaluate(() =>
      (window as unknown as { __folioTypo: TypoHook }).__folioTypo.validate({
        fontSize: "x",
        lineHeight: 2.5,
        fontFamily: "bad",
        columnWidth: 5,
      })
    );
    expect(out).toEqual({
      fontSize: 18,
      lineHeight: 2.4,
      fontFamily: "lora",
      columnWidth: 700,
    });
  });

  test("the __folioTypo hook is NOT exposed without the opt-in flag (production)", async ({
    browser,
  }) => {
    // Fresh context that never ran the beforeEach opt-in (it applied to the
    // default `page`, unused here) — proves the gate keeps the hook out of the
    // shipped reader.
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto("/");
    await p.locator(".grid .card").first().waitFor({ timeout: 15_000 });
    const hook = await p.evaluate(() => (window as unknown as { __folioTypo?: unknown }).__folioTypo);
    expect(hook).toBeUndefined();
    await ctx.close();
  });

  test("applies default typography to #reader-content", async ({ page }) => {
    await openEpubChapter(page);
    const cs = await readerContentStyle(page);
    expect(cs.fontSize).toBe("18px");
    expect(cs.lineHeight).toBe("1.8");
    expect(cs.maxWidth).toBe("700px");
    expect(cs.fontFamily).toContain("Lora Variable");
  });

  test("malformed stored typography falls back to defaults", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("folio-web-typography", "{not json"));
    await openEpubChapter(page);
    const cs = await readerContentStyle(page);
    expect(cs.fontSize).toBe("18px");
  });

  test("failed persist still applies for the session", async ({ page }) => {
    await page.addInitScript(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k === "folio-web-typography") throw new Error("quota");
        return orig.call(this, k, v);
      };
    });
    await openEpubChapter(page);
    await page.evaluate(() =>
      (window as unknown as { __folioTypo: TypoHook }).__folioTypo.set({ fontSize: 22 })
    );
    const fs = await page.evaluate(
      () => (window as unknown as { __folioTypo: TypoHook }).__folioTypo.get().fontSize
    );
    expect(fs).toBe(22); // in-memory survived the denied persist
  });
});

// Navigate to the long chapter 1 (ch1 was lengthened to ~60 paragraphs so the
// stage scrolls) and scroll to the middle.
async function openLongChapterMidScroll(page: Page) {
  await openEpubChapter(page);
  await page.locator("#reader-stage").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#reader-content")).toContainText("chapter one", { timeout: 10_000 });
  await page.locator("#reader-stage").evaluate((s) => {
    s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2);
  });
  await page.waitForTimeout(50);
}

// The text + top-edge offset of the paragraph currently at the stage's top.
async function topAnchor(page: Page) {
  return page.evaluate(() => {
    const stg = document.querySelector("#reader-stage") as HTMLElement;
    const content = document.querySelector("#reader-content") as HTMLElement;
    const stageTop = stg.getBoundingClientRect().top;
    for (const kid of Array.from(content.children)) {
      const r = kid.getBoundingClientRect();
      if (r.bottom > stageTop) return { text: kid.textContent, offset: r.top - stageTop };
    }
    return null;
  });
}

async function offsetOf(page: Page, text: string) {
  return page.evaluate((t) => {
    const stg = document.querySelector("#reader-stage") as HTMLElement;
    const content = document.querySelector("#reader-content") as HTMLElement;
    const stageTop = stg.getBoundingClientRect().top;
    const el = Array.from(content.children).find((k) => k.textContent === t);
    return el ? el.getBoundingClientRect().top - stageTop : null;
  }, text);
}

test.describe("Web reader typography — reflow preservation", () => {
  test("keeps the top paragraph in place when font size changes", async ({ page }) => {
    await openLongChapterMidScroll(page);
    const before = await topAnchor(page);
    expect(before).not.toBeNull();

    await page.evaluate(() =>
      (window as unknown as { __folioTypo: TypoHook }).__folioTypo.change({ fontSize: 24 })
    );
    await page.waitForTimeout(100);

    const after = await offsetOf(page, before!.text as string);
    expect(after).not.toBeNull();
    expect(Math.abs((after as number) - before!.offset)).toBeLessThan(12);
  });

  test("rapid changes settle with the top paragraph stable", async ({ page }) => {
    await openLongChapterMidScroll(page);
    const before = await topAnchor(page);
    expect(before).not.toBeNull();

    await page.evaluate(() => {
      const t = (window as unknown as { __folioTypo: TypoHook }).__folioTypo;
      t.change({ fontSize: 20 });
      t.change({ fontSize: 22 });
      t.change({ fontSize: 24 });
    });
    await page.waitForTimeout(150);

    const after = await offsetOf(page, before!.text as string);
    expect(after).not.toBeNull();
    expect(Math.abs((after as number) - before!.offset)).toBeLessThan(14);
  });

  test("a typography change does not jump reading position to the top", async ({ page }) => {
    await openLongChapterMidScroll(page);
    const stageRatio = () =>
      page.locator("#reader-stage").evaluate((s) => {
        const max = s.scrollHeight - s.clientHeight;
        return max > 0 ? s.scrollTop / max : 0;
      });
    const before = await stageRatio();
    await page.evaluate(() =>
      (window as unknown as { __folioTypo: TypoHook }).__folioTypo.change({ fontSize: 22 })
    );
    await page.waitForTimeout(100);
    const after = await stageRatio();
    // The reflow re-anchors rather than resetting to the top or NaN: the scroll
    // ratio stays a finite fraction close to where we were.
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThan(0.1);
    expect(Math.abs(after - before)).toBeLessThan(0.2);
  });
});
