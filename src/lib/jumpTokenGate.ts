/**
 * Pure decision logic for ReaderPane's F-1-5 "jump to source" gating.
 *
 * ReaderPane keeps two effects synchronized through an `appliedJumpToken`
 * ref:
 *   1. A `[bookId]`-only effect resets `appliedJumpToken.current` to the
 *      incoming `jumpToken` on every book switch — the mount effect (also
 *      keyed on `bookId`) is the one that applies the jump target in that
 *      case, so the jumpToken effect must not double-apply it.
 *   2. A `[jumpToken, ...]` effect applies the jump target only when
 *      `jumpToken` has advanced past the last-applied value.
 *
 * `resolveJumpTokenGate` computes effect 2's decision for a single commit.
 * Pass `bookIdChanged: true` to model effect 1 having just re-baselined the
 * ref on this same commit (a cross-book jump); `false` for an ordinary
 * same-book render.
 */
export interface JumpTokenGateResult {
  /** Whether the jumpToken effect should call applyJumpTarget this commit. */
  shouldApply: boolean;
  /** The `appliedJumpToken.current` value after this commit. */
  nextApplied: string | undefined;
}

export function resolveJumpTokenGate(
  jumpToken: string | undefined,
  appliedJumpToken: string | undefined,
  bookIdChanged: boolean,
): JumpTokenGateResult {
  // A book switch re-baselines the ref to the incoming jumpToken before the
  // jumpToken effect's own check runs (see effect 1 above) — so a cross-book
  // jump always finds jumpToken === baseline and is a no-op here.
  const baseline = bookIdChanged ? jumpToken : appliedJumpToken;
  const shouldApply = jumpToken !== undefined && jumpToken !== baseline;
  return { shouldApply, nextApplied: shouldApply ? jumpToken : baseline };
}
