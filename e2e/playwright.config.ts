import { defineConfig } from "@playwright/test";

// Runs against a deterministic, seeded Folio web server — see
// `src-tauri/examples/web_e2e_server.rs` for the exact fixture set (130
// books, known progress/zero-chapter/CBZ books, etc.) the specs in this
// directory assert against.
//
// Playwright manages the harness's lifecycle via `webServer` below: it
// builds+runs the example, polls `/api/health` until ready, and (outside
// CI, where `reuseExistingServer` is true) leaves an already-running
// instance alone so repeated local runs don't pay the cargo build cost
// every time.
const PORT = 7810;

export default defineConfig({
  // No explicit testDir: defaults to the directory containing this config
  // file (e2e/), which is what we want — __dirname isn't available here
  // since the repo is an ES module package ("type": "module").
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["html", { outputFolder: "./playwright-report", open: "never" }], ["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "cargo run --quiet --example web_e2e_server",
    cwd: "../src-tauri",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { FOLIO_E2E_PORT: String(PORT) },
  },
});
