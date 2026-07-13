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

// Wheel event with a real cursor position (image center unless clientX/Y
// given), dispatched straight at the image (bubbles to the #reader-stage
// listener). page.mouse.wheel can't set ctrlKey, so synthesize the event.
// Returns defaultPrevented — the handler's contract is observable: it must
// preventDefault when it consumes the wheel (zoom / zoomed pan) and must
// NOT when native behavior should win (plain wheel at 1x).
async function wheel(page: Page, init: WheelEventInit): Promise<boolean> {
  return page.$eval(
    "#page-img",
    (el, eventInit) => {
      const r = el.getBoundingClientRect();
      const ev = new WheelEvent("wheel", {
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
        cancelable: true,
        ...eventInit,
      });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    init,
  );
}

const ctrlWheel = (page: Page, deltaY: number) => wheel(page, { ctrlKey: true, deltaY });
const plainWheel = (page: Page, deltaX: number, deltaY: number) => wheel(page, { deltaX, deltaY });

test.describe("Reader zoom: wheel (M1)", () => {
  test("ctrl+wheel zooms in, clamps at 5x, and ctrl+wheel out clamps back to 1x", async ({ page }) => {
    await openCbzReader(page);
    expect(await getScale(page)).toBe(1);

    // The handler must claim the event — a real ctrl+wheel would otherwise
    // also zoom the whole browser viewport.
    expect(await ctrlWheel(page, -70)).toBe(true); // exp(0.7) ≈ 2.01
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

  test("ctrl+wheel zoom anchors the image point under the cursor", async ({ page }) => {
    await openCbzReader(page);
    await page.click("#fit-toggle-btn"); // fit-width: image spans the stage
    const before = await page.$eval("#page-img", (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    // Zoom about a point at 25% of the image's width (not the center) —
    // an implementation that ignores the cursor entirely fails this.
    const px = before.left + before.width * 0.25;
    const py = before.top + before.height * 0.5;
    await wheel(page, { ctrlKey: true, deltaY: -70, clientX: px, clientY: py });
    const s = await getScale(page);
    expect(s).toBeGreaterThan(1.5);
    const afterLeft = await page.$eval("#page-img", (el) => el.getBoundingClientRect().left);
    // Anchor invariant: the image-local point that was under the cursor
    // stays under it — (px - left) / scale is constant.
    const localBefore = px - before.left; // scale was 1
    const localAfter = (px - afterLeft) / s;
    expect(Math.abs(localAfter - localBefore)).toBeLessThan(1);
  });

  test("line-mode wheel deltas (Firefox mice) are normalized to pixels", async ({ page }) => {
    await openCbzReader(page);
    // 3 lines ≈ one Firefox wheel notch; must zoom meaningfully, not 3%.
    await wheel(page, { ctrlKey: true, deltaY: -3, deltaMode: 1 });
    expect(await getScale(page)).toBeGreaterThan(1.5);
  });

  test("plain wheel pans while zoomed and pan clamps at image edges", async ({ page }) => {
    await openCbzReader(page);
    // fit-width so the scaled image genuinely overflows the stage.
    await page.click("#fit-toggle-btn");
    await ctrlWheel(page, -70); // ~2x
    expect(await getScale(page)).toBeGreaterThan(1.5);

    // Review fix: .zoom-active must beat fit-width's overflow:auto — while
    // zoomed the stage never scrolls natively (pan owns all movement).
    expect(await page.$eval("#reader-stage", (el) => getComputedStyle(el).overflowY)).toBe("hidden");

    const leftBefore = await page.$eval("#page-img", (el) => el.getBoundingClientRect().left);

    // Pan hard toward bottom-right content (positive deltas scroll content
    // up/left visually — direction spec: pan moves content opposite the
    // wheel deltas, like native scrolling). Must be a consumed event.
    expect(await plainWheel(page, 2000, 2000)).toBe(true);
    const after = await page.$eval("#page-img", (el) => {
      const r = el.getBoundingClientRect();
      const s = document.querySelector("#reader-stage")!.getBoundingClientRect();
      return { imgLeft: r.left, imgRight: r.right, stageRight: s.right, imgBottom: r.bottom, stageBottom: s.bottom };
    });
    // The pan actually moved the image (guards against an inert handler —
    // the clamp inequalities below hold even for an untouched centered
    // image, so on their own they prove nothing).
    expect(after.imgLeft).toBeLessThan(leftBefore);
    // Clamped: the image's far edge never pulls inside the stage's far edge.
    expect(after.imgRight).toBeGreaterThanOrEqual(after.stageRight - 0.5);
    expect(after.imgBottom).toBeGreaterThanOrEqual(after.stageBottom - 0.5);

    // Pan hard the other way: near edge clamps too.
    await plainWheel(page, -4000, -4000);
    const back = await page.$eval("#page-img", (el) => {
      const r = el.getBoundingClientRect();
      const s = document.querySelector("#reader-stage")!.getBoundingClientRect();
      return { imgLeft: r.left, stageLeft: s.left };
    });
    expect(back.imgLeft).toBeLessThanOrEqual(back.stageLeft + 0.5);
  });

  test("while zoomed, edge taps don't turn the page (zoom preserved)", async ({ page }) => {
    await openCbzReader(page);
    await ctrlWheel(page, -70); // ~2x
    expect(await getScale(page)).toBeGreaterThan(1.5);
    const box = (await page.locator("#page-img").boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/0/read`));
    expect(await getScale(page)).toBeGreaterThan(1.5);
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

    // Plain wheel at 1x must be left to the browser (fit-width native
    // scroll) — the handler must not claim it.
    expect(await plainWheel(page, 0, -300)).toBe(false);
    expect(await getScale(page)).toBe(1);
  });
});
