export const config = {
  runner: "local",
  port: 4444,
  specs: [
    "./specs/smoke.mjs",
    "./specs/window.mjs",
    "./specs/navigation.mjs",
    "./specs/library.mjs",
    "./specs/settings.mjs",
    "./specs/theme.mjs",
    "./specs/import-dialog.mjs",
    "./specs/accessibility.mjs",
  ],
  maxInstances: 1,
  capabilities: [
    {
      "tauri:options": {
        binary: "../../src-tauri/target/debug/folio",
      },
    },
  ],
  logLevel: "info",
  waitforTimeout: 10000,
  connectionRetryTimeout: 30000,
  connectionRetryCount: 3,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
};
