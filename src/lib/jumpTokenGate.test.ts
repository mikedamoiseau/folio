import { describe, it, expect } from "vitest";
import { resolveJumpTokenGate } from "./jumpTokenGate";

// Pins the F-1-5 "jump to source" gating invariant (ReaderPane.tsx): the
// jumpToken effect must apply exactly once per distinct jump, and never
// double-apply on a cross-book jump where the mount effect already handled
// it. See the 4 scenarios traced in ReaderPane.tsx's comments above the
// `[bookId]` reset effect and the jumpToken effect.

describe("resolveJumpTokenGate", () => {
  it("(a) fresh mount: ref starts equal to the first-seen jumpToken, no apply", () => {
    // useRef(jumpToken) seeds appliedJumpToken to the initial jumpToken
    // value; the reset effect (bookIdChanged: true) re-baselines it to the
    // same value (no-op); the jumpToken effect then sees them equal.
    const result = resolveJumpTokenGate("t1", "t1", false);
    expect(result).toEqual({ shouldApply: false, nextApplied: "t1" });
  });

  it("(b) same-book jump: bookId unchanged, jumpToken advances — applies once", () => {
    const result = resolveJumpTokenGate("t2", "t1", false);
    expect(result).toEqual({ shouldApply: true, nextApplied: "t2" });
  });

  it("(c) cross-book jump: bookId and jumpToken change together — mount effect owns it, no double-apply", () => {
    // Reset effect fires first (bookIdChanged: true) and re-baselines the
    // ref to the incoming jumpToken.
    const afterReset = resolveJumpTokenGate("t2", "t1", true);
    expect(afterReset.nextApplied).toBe("t2");

    // jumpToken effect then runs against the already-updated ref
    // (bookIdChanged is always false from its own perspective).
    const result = resolveJumpTokenGate("t2", afterReset.nextApplied, false);
    expect(result).toEqual({ shouldApply: false, nextApplied: "t2" });
  });

  it("(d) ordinary re-render: neither bookId nor jumpToken changed — no apply", () => {
    const result = resolveJumpTokenGate("t1", "t1", false);
    expect(result).toEqual({ shouldApply: false, nextApplied: "t1" });
  });

  it("does not apply when jumpToken is undefined (no navigation carried a jump)", () => {
    const result = resolveJumpTokenGate(undefined, undefined, false);
    expect(result).toEqual({ shouldApply: false, nextApplied: undefined });
  });

  it("a bookId change alone (jumpToken unchanged) re-baselines without applying", () => {
    const result = resolveJumpTokenGate("t1", "t1", true);
    expect(result).toEqual({ shouldApply: false, nextApplied: "t1" });
  });
});
