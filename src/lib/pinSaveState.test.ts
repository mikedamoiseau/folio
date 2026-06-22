import { describe, it, expect } from "vitest";
import { isPinUnsaved, shouldSaveOnBlur } from "./pinSaveState";

describe("isPinUnsaved", () => {
  it("is false for an empty PIN", () => {
    expect(isPinUnsaved("", "")).toBe(false);
    expect(isPinUnsaved("", "4827")).toBe(false);
  });

  it("is true when a non-empty PIN has not been persisted", () => {
    expect(isPinUnsaved("4827", "")).toBe(true);
  });

  it("is false once the typed PIN matches the persisted PIN", () => {
    expect(isPinUnsaved("4827", "4827")).toBe(false);
  });

  it("is dirty again when the typed PIN differs from the persisted one", () => {
    // Edited after a save: persisted is "4827" but the field now holds "9510".
    expect(isPinUnsaved("9510", "4827")).toBe(true);
  });
});

describe("shouldSaveOnBlur", () => {
  it("fires for an unsaved, valid PIN", () => {
    expect(shouldSaveOnBlur("4827", "", true)).toBe(true);
  });

  it("does not fire for an invalid PIN (preserves validation gate)", () => {
    expect(shouldSaveOnBlur("12", "", false)).toBe(false);
    expect(shouldSaveOnBlur("0000", "", false)).toBe(false);
  });

  it("does not fire for an empty PIN", () => {
    expect(shouldSaveOnBlur("", "", true)).toBe(false);
  });

  it("does not re-fire once the PIN has been persisted (the F4b bug)", () => {
    // After a successful save, savedPin == webServerPin, so a later blur
    // (even after the transient "saved ✓" flag clears) must not re-submit.
    expect(shouldSaveOnBlur("4827", "4827", true)).toBe(false);
  });

  it("fires again after the persisted PIN is edited to a new valid value", () => {
    expect(shouldSaveOnBlur("9510", "4827", true)).toBe(true);
  });
});
