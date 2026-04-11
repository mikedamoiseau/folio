import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { LiveRegion } from "./LiveRegion";

describe("LiveRegion", () => {
  it("renders with aria-live=polite by default", () => {
    const html = renderToString(<LiveRegion message="Book imported" />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("Book imported");
  });

  it("renders with aria-live=assertive when urgent", () => {
    const html = renderToString(<LiveRegion message="Error!" assertive />);
    expect(html).toContain('aria-live="assertive"');
  });

  it("is visually hidden (sr-only)", () => {
    const html = renderToString(<LiveRegion message="Test" />);
    // sr-only is a Tailwind class — check it's present
    expect(html).toContain("sr-only");
  });

  it("renders empty when no message", () => {
    const html = renderToString(<LiveRegion message="" />);
    // Should still render the container (screen readers need it in the DOM)
    expect(html).toContain('aria-live="polite"');
  });
});
