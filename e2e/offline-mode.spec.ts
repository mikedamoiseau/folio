import { test, expect } from "@playwright/test";

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
