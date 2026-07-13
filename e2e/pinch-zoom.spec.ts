import { test, expect, type Page } from "@playwright/test";

// Pinch-to-zoom coverage for reader page mode. See
// docs/superpowers/specs/2026-07-13-web-ui-pinch-zoom-design.md.
//
// The harness CBZ's pages are tiny PNGs (natural size far below the stage),
// so in fit-height the scaled image often still fits inside the stage and
// pan clamping just re-centers it. Pan tests therefore switch to fit-width
// (image width = stage width) so scale > 1 genuinely overflows the stage.
const READER_BOOK_ID = "e2e-book-130";

async function openCbzReader(page: Page) {
  await page.goto(`/#/book/${READER_BOOK_ID}`);
  // Same idempotent entry as core-smoke.spec.ts: a prior run leaves progress,
  // turning "Read" into "Continue"/"Start Over".
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

// Current scale of #page-img (identity transform or "none" -> 1).
async function getScale(page: Page): Promise<number> {
  return page.$eval("#page-img", (el) => {
    const t = getComputedStyle(el).transform;
    return t === "none" ? 1 : new DOMMatrix(t).a;
  });
}

// ctrl+wheel with a real cursor position, dispatched straight at the image
// (bubbles to the #reader-stage listener). page.mouse.wheel can't set
// ctrlKey, so synthesize the event.
async function ctrlWheel(page: Page, deltaY: number) {
  await page.$eval(
    "#page-img",
    (el, dy) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: dy,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    deltaY,
  );
}

async function plainWheel(page: Page, deltaX: number, deltaY: number) {
  await page.$eval(
    "#page-img",
    (el, d: { x: number; y: number }) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: d.x,
          deltaY: d.y,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { x: deltaX, y: deltaY },
  );
}

test.describe("Reader zoom: wheel (M1)", () => {
  test("ctrl+wheel zooms in, clamps at 5x, and ctrl+wheel out clamps back to 1x", async ({ page }) => {
    await openCbzReader(page);
    expect(await getScale(page)).toBe(1);

    await ctrlWheel(page, -70); // exp(0.7) ≈ 2.01
    const zoomed = await getScale(page);
    expect(zoomed).toBeGreaterThan(1.5);
    expect(zoomed).toBeLessThan(3);

    await ctrlWheel(page, -500); // exp(5) — way past max, must clamp
    expect(await getScale(page)).toBe(5);

    await ctrlWheel(page, 500); // way past min, must clamp
    expect(await getScale(page)).toBe(1);
    // At 1x the transform is fully cleared, not translate(...) scale(1).
    const transform = await page.$eval("#page-img", (el) => el.style.transform);
    expect(transform).toBe("");
  });

  test("plain wheel pans while zoomed and pan clamps at image edges", async ({ page }) => {
    await openCbzReader(page);
    // fit-width so the scaled image genuinely overflows the stage.
    await page.click("#fit-toggle-btn");
    await ctrlWheel(page, -70); // ~2x
    expect(await getScale(page)).toBeGreaterThan(1.5);

    // Pan hard toward bottom-right content (positive deltas scroll content
    // up/left visually — direction spec: pan moves content opposite the
    // wheel deltas, like native scrolling).
    await plainWheel(page, 2000, 2000);
    const after = await page.$eval("#page-img", (el) => {
      const r = el.getBoundingClientRect();
      const s = document.querySelector("#reader-stage")!.getBoundingClientRect();
      return { imgRight: r.right, stageRight: s.right, imgBottom: r.bottom, stageBottom: s.bottom };
    });
    // Clamped: the image's far edge never pulls inside the stage's far edge.
    expect(after.imgRight).toBeGreaterThanOrEqual(after.stageRight - 0.5);

    // Pan hard the other way: near edge clamps too.
    await plainWheel(page, -4000, -4000);
    const back = await page.$eval("#page-img", (el) => {
      const r = el.getBoundingClientRect();
      const s = document.querySelector("#reader-stage")!.getBoundingClientRect();
      return { imgLeft: r.left, stageLeft: s.left };
    });
    expect(back.imgLeft).toBeLessThanOrEqual(back.stageLeft + 0.5);
  });

  test("page turn and fit toggle reset zoom to 1x; plain wheel at 1x does not zoom", async ({ page }) => {
    await openCbzReader(page);
    await ctrlWheel(page, -70);
    expect(await getScale(page)).toBeGreaterThan(1.5);

    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/1/read`), { timeout: 10_000 });
    expect(await getScale(page)).toBe(1);

    await ctrlWheel(page, -70);
    expect(await getScale(page)).toBeGreaterThan(1.5);
    await page.click("#fit-toggle-btn");
    expect(await getScale(page)).toBe(1);

    await plainWheel(page, 0, -300);
    expect(await getScale(page)).toBe(1);
  });
});
