// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOnboarding } from "./useOnboarding";

const STORAGE_KEY = "folio-onboarding-complete";

describe("useOnboarding", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns isActive true when localStorage flag absent", () => {
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.isActive).toBe(true);
    expect(result.current.currentStep).toBe(1);
  });

  it("returns isActive false when localStorage flag set", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.isActive).toBe(false);
  });

  it("advance() increments step from 1 to 2 to 3", () => {
    const { result } = renderHook(() => useOnboarding());
    expect(result.current.currentStep).toBe(1);

    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(2);

    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(3);
  });

  it("advance() does not go past step 3", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.advance());
    act(() => result.current.advance());
    act(() => result.current.advance());
    expect(result.current.currentStep).toBe(3);
  });

  it("skip() sets localStorage flag and isActive to false", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.skip());
    expect(result.current.isActive).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("complete() sets localStorage flag and isActive to false", () => {
    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.advance());
    act(() => result.current.advance());
    act(() => result.current.complete());
    expect(result.current.isActive).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });
});
