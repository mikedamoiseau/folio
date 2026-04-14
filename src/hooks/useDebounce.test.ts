import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce, useDebounce } from "./useDebounce";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

describe("debounce utility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays execution by the specified time", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced("a");
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith("a");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets timer on rapid calls, only fires last value", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced("a");
    vi.advanceTimersByTime(200);
    debounced("b");
    vi.advanceTimersByTime(200);
    debounced("c");
    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("cancel stops pending execution", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced("a");
    debounced.cancel();
    vi.advanceTimersByTime(300);

    expect(fn).not.toHaveBeenCalled();
  });
});

describe("useDebounce hook (SSR)", () => {
  it("returns initial value on first render", () => {
    function TestComponent() {
      const debounced = useDebounce("hello", 150);
      return createElement("span", null, debounced);
    }
    const html = renderToString(createElement(TestComponent));
    expect(html).toContain("hello");
  });

  it("returns empty string when initialized with empty string", () => {
    function TestComponent() {
      const debounced = useDebounce("", 150);
      return createElement("span", null, `[${debounced}]`);
    }
    const html = renderToString(createElement(TestComponent));
    expect(html).toContain("[]");
  });
});
