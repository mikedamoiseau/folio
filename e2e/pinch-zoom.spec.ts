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
    // The hash flips synchronously but the render (and its zoom reset) is
    // async — poll instead of a single read.
    await expect.poll(async () => getScale(page)).toBe(1);

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

// ── M2: touch ──────────────────────────────────────────────────────────
// Synthetic TouchEvents dispatched at #reader-stage (the gesture
// controller's element from M2 on). hasTouch is required for the Touch/
// TouchEvent constructors to exist in Chromium.
test.describe("Reader zoom: touch (M2)", () => {
  test.use({ hasTouch: true });

  type Pt = { x: number; y: number };

  // Dispatch a touch event. `changed` = fingers this event is about;
  // `active` = full touch list still on screen AFTER the event (defaults:
  // [] for touchend/touchcancel, `changed` otherwise — pass it explicitly
  // to model lifting one finger of a pinch). Returns defaultPrevented so
  // tests can assert who claimed the event.
  async function touch(page: Page, type: string, changed: Pt[], active?: Pt[]): Promise<boolean> {
    return page.$eval(
      "#reader-stage",
      (el, arg: { type: string; changed: Pt[]; active: Pt[] | null }) => {
        const ended = arg.type === "touchend" || arg.type === "touchcancel";
        const mk = (points: Pt[], base: number) =>
          points.map((p, i) => new Touch({ identifier: base + i, target: el, clientX: p.x, clientY: p.y }));
        const activeTouches = arg.active !== null ? mk(arg.active, 100) : ended ? [] : mk(arg.changed, 0);
        const ev = new TouchEvent(arg.type, {
          touches: activeTouches,
          changedTouches: mk(arg.changed, 0),
          targetTouches: activeTouches,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      { type, changed, active: active ?? null },
    );
  }

  async function stageCenter(page: Page) {
    return page.$eval("#reader-stage", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  }

  test("two-finger pinch zooms about the midpoint; moving the midpoint pans", async ({ page }) => {
    await openCbzReader(page);
    await page.click("#fit-toggle-btn"); // fit-width so a moving midpoint has clamp room
    const c = await stageCenter(page);
    await touch(page, "touchstart", [{ x: c.x - 50, y: c.y }, { x: c.x + 50, y: c.y }]);
    // Pinch moves must be claimed (preventDefault) or the browser would
    // also scroll/zoom natively.
    expect(await touch(page, "touchmove", [{ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y }])).toBe(true);
    // Finger distance doubled: 100px -> 200px.
    const s = await getScale(page);
    expect(s).toBeGreaterThan(1.8);
    expect(s).toBeLessThan(2.2);

    // Constant-spread two-finger drag: the content anchored between the
    // fingers must follow the midpoint (+60px right).
    const leftBefore = await page.$eval("#page-img", (el) => el.getBoundingClientRect().left);
    await touch(page, "touchmove", [{ x: c.x - 40, y: c.y }, { x: c.x + 160, y: c.y }]);
    const leftAfter = await page.$eval("#page-img", (el) => el.getBoundingClientRect().left);
    expect(leftAfter - leftBefore).toBeGreaterThan(55);
    expect(leftAfter - leftBefore).toBeLessThan(65);
    await touch(page, "touchend", [{ x: c.x - 40, y: c.y }, { x: c.x + 160, y: c.y }]);
  });

  test("pinch → lift one finger → remaining finger pans", async ({ page }) => {
    await openCbzReader(page);
    await page.click("#fit-toggle-btn"); // fit-width so 2x overflows
    const c = await stageCenter(page);
    await touch(page, "touchstart", [{ x: c.x - 50, y: c.y }, { x: c.x + 50, y: c.y }]);
    await touch(page, "touchmove", [{ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y }]);
    expect(await getScale(page)).toBeGreaterThan(1.8);
    // Lift the left finger only — the right one stays down.
    await touch(page, "touchend", [{ x: c.x - 100, y: c.y }], [{ x: c.x + 100, y: c.y }]);
    const leftBefore = await page.$eval("#page-img", (el) => el.getBoundingClientRect().left);
    expect(await touch(page, "touchmove", [{ x: c.x + 40, y: c.y - 30 }])).toBe(true);
    const leftAfter = await page.$eval("#page-img", (el) => el.getBoundingClientRect().left);
    expect(leftAfter).toBeLessThan(leftBefore); // panned left with the finger
    await touch(page, "touchend", [{ x: c.x + 40, y: c.y - 30 }]);
    expect(await getScale(page)).toBeGreaterThan(1.8); // zoom survived
  });

  test("one-finger drag pans while zoomed and never turns the page", async ({ page }) => {
    await openCbzReader(page);
    await page.click("#fit-toggle-btn"); // fit-width so 2x overflows
    await ctrlWheel(page, -70); // ~2x
    const before = await page.$eval("#page-img", (el) => el.getBoundingClientRect().left);
    const c = await stageCenter(page);
    await touch(page, "touchstart", [{ x: c.x, y: c.y }]);
    await touch(page, "touchmove", [{ x: c.x - 80, y: c.y - 60 }]);
    await touch(page, "touchend", [{ x: c.x - 80, y: c.y - 60 }]);
    const after = await page.$eval("#page-img", (el) => el.getBoundingClientRect().left);
    expect(after).toBeLessThan(before); // image followed the finger left
    // Still on page 0 — an 80px horizontal drag at 1x would have turned.
    await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/0/read`));
    expect(await getScale(page)).toBeGreaterThan(1.5); // zoom survives the drag
  });

  test("swipe at 1x still turns the page; vertical drag at 1x stays native (regression)", async ({ page }) => {
    await openCbzReader(page);
    const c = await stageCenter(page);
    // A vertical drag at 1x must NOT be claimed — fit-width native
    // scrolling depends on it.
    await touch(page, "touchstart", [{ x: c.x, y: c.y }]);
    expect(await touch(page, "touchmove", [{ x: c.x, y: c.y + 60 }])).toBe(false);
    await touch(page, "touchend", [{ x: c.x, y: c.y + 60 }]);

    await touch(page, "touchstart", [{ x: c.x + 100, y: c.y }]);
    await touch(page, "touchmove", [{ x: c.x + 40, y: c.y }]);
    await touch(page, "touchmove", [{ x: c.x - 20, y: c.y }]);
    await touch(page, "touchend", [{ x: c.x - 20, y: c.y }]); // dx = -120
    await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/1/read`), { timeout: 10_000 });
  });

  test("touchcancel mid-pinch keeps the current zoom", async ({ page }) => {
    await openCbzReader(page);
    const c = await stageCenter(page);
    await touch(page, "touchstart", [{ x: c.x - 50, y: c.y }, { x: c.x + 50, y: c.y }]);
    await touch(page, "touchmove", [{ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y }]);
    await touch(page, "touchcancel", [{ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y }]);
    expect(await getScale(page)).toBeGreaterThan(1.8);
  });
});

// ── M3: double-tap / deferred tap zones ────────────────────────────────
// locator.dblclick() fires two click events within the double-tap window —
// the same event stream a fast touch double-tap produces through the
// browser's synthesized clicks.
test.describe("Reader zoom: double-tap + tap zones (M3)", () => {
  test("double-click toggles 2.5x and back, without firing the tap-zone action", async ({ page }) => {
    await openCbzReader(page);
    const chromeHiddenBefore = await page.$eval("#reader-root", (el) => el.classList.contains("chrome-hidden"));

    await page.locator("#page-img").dblclick(); // center zone = chrome toggle if it leaked through
    expect(await getScale(page)).toBe(2.5);
    // Still on page 0 and chrome state untouched — the deferred single-tap
    // action was cancelled by the second tap.
    await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/0/read`));
    await page.waitForTimeout(400); // outlive the defer window before checking
    const chromeHiddenAfter = await page.$eval("#reader-root", (el) => el.classList.contains("chrome-hidden"));
    expect(chromeHiddenAfter).toBe(chromeHiddenBefore);

    await page.locator("#page-img").dblclick();
    expect(await getScale(page)).toBe(1);
  });

  test("single tap still fires its zone action, after the defer window", async ({ page }) => {
    await openCbzReader(page);
    // Right-third click = next page. Deferred ~275ms, so poll the URL.
    const img = page.locator("#page-img");
    const box = (await img.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/1/read`), { timeout: 5_000 });
  });

  test("double-click on the right third zooms instead of turning two pages", async ({ page }) => {
    await openCbzReader(page);
    const img = page.locator("#page-img");
    const box = (await img.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width * 0.9, box.y + box.height / 2);
    expect(await getScale(page)).toBe(2.5);
    // Wait out the defer window, then confirm no page turn ever fired.
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(new RegExp(`#/book/${READER_BOOK_ID}/0/read`));
  });

  test("while zoomed, center tap still toggles chrome (deferred)", async ({ page }) => {
    await openCbzReader(page);
    // fit-width + ~2x: the image box extends past the viewport, so click
    // coordinates must come from the (viewport-sized) stage box — zone
    // thirds are computed against the image rect, so the stage center lands
    // in the image's middle third.
    await page.click("#fit-toggle-btn");
    await ctrlWheel(page, -70); // ~2x
    const stage = (await page.locator("#reader-stage").boundingBox())!;
    await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await expect
      .poll(async () => page.$eval("#reader-root", (el) => el.classList.contains("chrome-hidden")))
      .toBe(true);
    expect(await getScale(page)).toBeGreaterThan(1.5); // zoom kept
  });
});
