import { test, expect, type Page } from "@playwright/test";

// Harness fixtures (src-tauri/examples/web_e2e_server.rs): Book 050 = the
// only EPUB with a real 2-chapter file (chapter 1 embeds one inline image);
// Book 130 = the only CBZ with a real 2-page file.
const EPUB_ID = "e2e-book-050";
const CBZ_ID = "e2e-book-130";

async function saveBookOffline(page: Page, bookId: string) {
  await page.goto(`/#/book/${bookId}`);
  await page.locator("#offline-save-btn").click();
  await expect(page.locator("#offline-remove-btn")).toBeVisible({ timeout: 30_000 });
}

// Offline mode (spec docs/superpowers/specs/2026-07-17-web-reader-offline-design.md).
//
// M2 — service-worker foundations: the activate handler's shell-version
// cleanup must never delete per-book offline content caches
// (`folio-offline-book-*`), while still purging stale shell caches. Playwright
// runs against localhost (a secure context), so the service worker registers
// exactly as it does on the HTTPS deployments offline mode targets.

test.describe("offline mode — service worker foundations", () => {
  test("activation purge spares offline book caches, kills stale shell caches", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForFunction(() => navigator.serviceWorker?.ready.then(() => true), null, {
      timeout: 15_000,
    });

    // Plant a fake offline book cache (survivor) and a stale shell-version
    // cache (must die), then force a fresh SW install+activate cycle so the
    // activate purge runs with both present.
    await page.evaluate(async () => {
      await caches.open("folio-offline-book-e2e-fake");
      await caches.open("folio-shell-deadbeef0000");
      const reg = await navigator.serviceWorker.getRegistration();
      await reg!.unregister();
    });

    await page.reload();
    await page.waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return !!reg?.active;
      },
      null,
      { timeout: 15_000 },
    );
    // The purge promise isn't awaitable from the page, so poll until the
    // stale shell cache is gone…
    await expect
      .poll(async () => page.evaluate(() => caches.keys()), { timeout: 10_000 })
      .not.toContain("folio-shell-deadbeef0000");

    // …then confirm the survivor is STILL there after the purge settles — a
    // single immediate read could race a concurrent (regressed) delete of the
    // offline cache and pass intermittently.
    await page.waitForTimeout(500);
    const keys = await page.evaluate(() => caches.keys());
    expect(keys).toContain("folio-offline-book-e2e-fake");
    expect(keys).not.toContain("folio-shell-deadbeef0000");
  });
});

test.describe("offline mode — save / unsave (M3)", () => {
  test("saving an EPUB caches its full inventory and flips the detail UI", async ({ page }) => {
    await saveBookOffline(page, EPUB_ID);

    // Detail view shows the saved state.
    await expect(page.locator(".offline-saved-label")).toContainText(/Saved ·/);

    // The cache holds detail JSON, covers, TOC, both chapters, and the
    // chapter-1 inline image; the manifest row exists with a matching hash.
    const state = await page.evaluate(async (id) => {
      const cache = await caches.open(`folio-offline-book-${id}`);
      const keys = (await cache.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open("folio-offline");
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const row = await new Promise<any>((res, rej) => {
        const tx = db.transaction("books", "readonly");
        const r = tx.objectStore("books").get(id);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return { keys, row };
    }, EPUB_ID);

    expect(state.keys).toContain(`/api/books/${EPUB_ID}`);
    // These harness books have no cover file, so /cover 404s and the optional-
    // cover skip drops it from the inventory — proving the skip path works.
    expect(state.keys).not.toContain(`/api/books/${EPUB_ID}/cover`);
    expect(state.keys).toContain(`/api/books/${EPUB_ID}/chapters`);
    expect(state.keys).toContain(`/api/books/${EPUB_ID}/chapters/0`);
    expect(state.keys).toContain(`/api/books/${EPUB_ID}/chapters/1`);
    expect(state.keys.some((k: string) => k.startsWith(`/api/books/${EPUB_ID}/images/`))).toBe(true);
    expect(state.row).toBeTruthy();
    expect(state.row.generation).toBeTruthy();

    // The manifest hash must actually equal the hash of the cached key set —
    // recompute it independently (dedup + sort + SHA-256, the same canonical
    // form the app uses) so a wrong/short hash or a missing key can't pass.
    const recomputed = await page.evaluate(async (keys) => {
      const canonical = Array.from(new Set(keys)).sort().join("\n");
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }, state.keys);
    expect(state.row.inventoryHash).toBe(recomputed);

    // Grid badge appears for the saved book only. (Book 050 isn't on grid
    // page 1 under the default recent-first sort — search brings it up.)
    await page.goto("/#/?q=Book%20050");
    const savedCard = page.locator(".grid .card", { hasText: "Book 050" });
    await savedCard.waitFor();
    await expect(savedCard.locator(".offline-badge")).toBeVisible();
  });

  test("saving a CBZ downloads pages at OFFLINE_PAGE_WIDTH", async ({ page }) => {
    const widthRequest = page.waitForRequest((r) =>
      r.url().includes(`/api/books/${CBZ_ID}/pages/0`) && r.url().includes("width=1080"),
    );
    await saveBookOffline(page, CBZ_ID);
    await widthRequest;

    const keys = await page.evaluate(async (id) => {
      const cache = await caches.open(`folio-offline-book-${id}`);
      return (await cache.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
    }, CBZ_ID);
    expect(keys).toContain(`/api/books/${CBZ_ID}/pages/0?width=1080`);
    expect(keys).toContain(`/api/books/${CBZ_ID}/pages/1?width=1080`);
    expect(keys).toContain(`/api/books/${CBZ_ID}/page-count`);
  });

  test("network-first: online reads bypass the cache; offline falls back to it", async ({
    page,
    context,
  }) => {
    await saveBookOffline(page, EPUB_ID);

    // Poison the cached chapter 1 with a sentinel.
    await page.evaluate(async (id) => {
      const cache = await caches.open(`folio-offline-book-${id}`);
      await cache.put(
        new Request(`/api/books/${id}/chapters/1`),
        new Response("<p>SENTINEL-CACHED</p>", { headers: { "Content-Type": "text/html" } }),
      );
    }, EPUB_ID);

    // ONLINE: open the reader at chapter 1 — network must win.
    await page.goto(`/#/book/${EPUB_ID}/1/read`);
    const restart = page.locator("#resume-restart-btn");
    const content = page.locator("#reader-content");
    await expect(restart.or(content)).toBeVisible({ timeout: 15_000 });
    if (await restart.isVisible()) await restart.click();
    await expect(content).toContainText("chapter one", { timeout: 10_000 });
    await expect(content).not.toContainText("SENTINEL-CACHED");

    // OFFLINE: the same URL fetched directly is now served by the SW cache
    // fallback → sentinel bytes. (A reader page-turn wouldn't prove this —
    // the F-4-4 in-memory prefetch cache would satisfy it without any
    // network/SW involvement.)
    await context.setOffline(true);
    const offlineBody = await page.evaluate(async (id) => {
      const resp = await fetch(`/api/books/${id}/chapters/1`, { credentials: "same-origin" });
      return resp.text();
    }, EPUB_ID);
    expect(offlineBody).toContain("SENTINEL-CACHED");
    await context.setOffline(false);
  });

  test("a second concurrent save of the same book is rejected, not duplicated", async ({ page }) => {
    // The single-flight guard: once a save starts the button flips to a
    // disabled Downloading state, so the UI can't initiate a second, and
    // exactly one manifest row is published.
    await page.goto(`/#/book/${CBZ_ID}`);
    await page.locator("#offline-save-btn").click();
    await expect(page.locator("#offline-remove-btn")).toBeVisible({ timeout: 30_000 });
    // Exactly one manifest row for this book (no duplicate from the guard).
    const count = await page.evaluate(async (id) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open("folio-offline");
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const rows = await new Promise<any[]>((res) => {
        const tx = db.transaction("books", "readonly");
        const r = tx.objectStore("books").getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => res([]);
      });
      return rows.filter((row) => row.id === id).length;
    }, CBZ_ID);
    expect(count).toBe(1);
  });

  test("a chapter book with unknown chapter count gets no save affordance", async ({ page }) => {
    // Book 060: EPUB with total_chapters = 0 (a legitimate "count not known
    // yet" state). Saving it would publish a phantom offline book with zero
    // readable content — the UI must not offer it.
    await page.goto("/#/book/e2e-book-060");
    await expect(page.locator(".detail .actions")).toBeVisible();
    await expect(page.locator("#offline-save-btn")).toHaveCount(0);
    await expect(page.locator("#offline-remove-btn")).toHaveCount(0);
  });

  test("unsave removes the cache, manifest row, and badge", async ({ page }) => {
    await saveBookOffline(page, EPUB_ID);
    await page.locator("#offline-remove-btn").click();
    await expect(page.locator("#offline-save-btn")).toBeVisible({ timeout: 10_000 });

    const gone = await page.evaluate(async (id) => {
      const hasCache = await caches.has(`folio-offline-book-${id}`);
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open("folio-offline");
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const row = await new Promise<any>((res) => {
        const tx = db.transaction("books", "readonly");
        const r = tx.objectStore("books").get(id);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(undefined);
      });
      return { hasCache, row };
    }, EPUB_ID);
    expect(gone.hasCache).toBe(false);
    expect(gone.row).toBeFalsy();

    await page.goto("/#/?q=Book%20050");
    const card = page.locator(".grid .card", { hasText: "Book 050" });
    await card.waitFor();
    await expect(card.locator(".offline-badge")).toHaveCount(0);
  });
});

test.describe("offline mode — boot & offline library (M4)", () => {
  test("booting offline with saved books shows the offline library and reads", async ({
    page,
    context,
  }) => {
    await saveBookOffline(page, EPUB_ID);

    // Boot offline from a top-level route: the SW-cached shell loads, init()
    // probes /api/books, the network fails, and the offline library renders
    // from IndexedDB.
    await page.goto("/#/");
    await context.setOffline(true);
    await page.reload();

    await expect(page.locator(".offline-banner")).toBeVisible();
    const card = page.locator(".grid .card", { hasText: "Book 050" });
    await expect(card).toHaveCount(1); // only the saved book

    // Open it → detail renders offline (cached detail JSON via SW fallback).
    await card.click();
    await expect(page.locator(".detail")).toBeVisible();
    // Read → chapter renders offline.
    await page.getByRole("button", { name: /^read$/i }).click();
    await expect(page.locator("#reader-content")).toContainText("chapter zero", { timeout: 15_000 });

    await context.setOffline(false);
  });

  test("Retry from the offline library recovers the online library", async ({ page, context }) => {
    await saveBookOffline(page, EPUB_ID);
    await page.goto("/#/");
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator(".offline-banner")).toBeVisible();

    await context.setOffline(false);
    await page.locator("#offline-retry-btn").click();
    // Back online: full library (search box present, offline banner gone).
    await expect(page.locator("#search")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".offline-banner")).toHaveCount(0);
  });

  test("offline deep-link to a NON-saved book redirects to the offline library", async ({
    page,
    context,
  }) => {
    await saveBookOffline(page, EPUB_ID); // 050 saved; 130 is not
    await page.goto("/#/");
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator(".offline-banner")).toBeVisible();

    // Navigate to an un-downloaded book's URL — must land on the offline
    // library, not a bare "couldn't reach server" dead-end.
    await page.evaluate((id) => { location.hash = `#/book/${id}`; }, CBZ_ID);
    await expect(page.locator(".offline-banner")).toBeVisible();
    await expect(page.locator(".grid .card", { hasText: "Book 050" })).toHaveCount(1);
    await context.setOffline(false);
  });

  test("ordinary navigation recovers the online library after reconnect", async ({
    page,
    context,
  }) => {
    await saveBookOffline(page, EPUB_ID);
    await page.goto("/#/");
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator(".offline-banner")).toBeVisible();

    // Reconnect, then navigate normally (NOT the Retry button) — the offline
    // library's re-probe must recover the full library with search.
    await context.setOffline(false);
    await page.evaluate(() => { location.hash = "#/library"; });
    await expect(page.locator("#search")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".offline-banner")).toHaveCount(0);
  });

  test("booting offline with no saved books shows the offline card", async ({ page, context }) => {
    // Ensure nothing is saved.
    await page.goto("/#/");
    await page.evaluate(async () => {
      for (const k of await caches.keys()) {
        if (k.startsWith("folio-offline-book-")) await caches.delete(k);
      }
      await new Promise<void>((res) => {
        const req = indexedDB.open("folio-offline");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("books", "readwrite");
          tx.objectStore("books").clear();
          tx.oncomplete = () => res();
          tx.onerror = () => res();
        };
        req.onerror = () => res();
      });
    });

    await context.setOffline(true);
    await page.reload();
    // No manifests → the plain "couldn't reach server" card, not a library.
    await expect(page.locator("#retry-init-btn")).toBeVisible();
    await expect(page.locator(".offline-banner")).toHaveCount(0);
    await context.setOffline(false);
  });
});
