import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { ToastProvider, ToastContainer, TOAST_AUTO_DISMISS_MS } from "./Toast";

describe("Toast System", () => {
  it("ToastProvider renders children", () => {
    const html = renderToString(
      <ToastProvider>
        <div>child</div>
      </ToastProvider>
    );
    expect(html).toContain("child");
  });

  it("ToastContainer renders with correct role", () => {
    const html = renderToString(
      <ToastProvider>
        <ToastContainer />
      </ToastProvider>
    );
    // Container should have aria-live for screen readers
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
  });

  it("ToastContainer renders at bottom-center position", () => {
    const html = renderToString(
      <ToastProvider>
        <ToastContainer />
      </ToastProvider>
    );
    expect(html).toContain("fixed");
    expect(html).toContain("bottom");
  });

  it("auto-dismisses transient toasts after the documented interval", () => {
    // Locks the doc/code contract: toasts are short-lived (4s). Anything
    // longer-lived should use an inline banner — see UX-CONVENTIONS.md.
    expect(TOAST_AUTO_DISMISS_MS).toBe(4000);
  });
});
