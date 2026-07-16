import { describe, it, expect } from "vitest";
import en from "../en.json";
import fr from "../fr.json";

// Every key this feature adds. Both locales must define all of them.
const NEW_KEYS = [
  "updateCheck.titleAvailable", "updateCheck.titleUpToDate", "updateCheck.titleError",
  "updateCheck.newVersion", "updateCheck.currentVersion", "updateCheck.upToDateBody",
  "updateCheck.errorBody", "updateCheck.rateLimitBody", "updateCheck.notesHeading",
  "updateCheck.notesEmpty", "updateCheck.fullChangelog", "updateCheck.download",
  "updateCheck.close", "updateCheck.loading",
  "settings.updateCheckOnStartup", "settings.updateCheckOnStartupHint",
];

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe("update-check locale key parity", () => {
  it.each(NEW_KEYS)("%s is a non-empty string in EN and FR", (key) => {
    expect(typeof get(en, key)).toBe("string");
    expect((get(en, key) as string).length).toBeGreaterThan(0);
    expect(typeof get(fr, key)).toBe("string");
    expect((get(fr, key) as string).length).toBeGreaterThan(0);
  });
});
