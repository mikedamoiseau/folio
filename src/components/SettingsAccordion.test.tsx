// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Accordion } from "./SettingsPanel";

afterEach(() => cleanup());

describe("Settings Accordion search filtering", () => {
  it("renders normally when there is no query (respecting open state)", () => {
    render(
      <Accordion title="Appearance" open={false} onToggle={() => {}}>
        <p>body</p>
      </Accordion>
    );
    expect(screen.getByText("Appearance")).toBeInTheDocument();
  });

  it("hides a section whose title and keywords do not match the query", () => {
    render(
      <Accordion title="Appearance" open onToggle={() => {}} query="sftp" keywords="theme font color">
        <p>body</p>
      </Accordion>
    );
    expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
  });

  it("shows a section when the query matches its keywords (not just the title)", () => {
    render(
      <Accordion title="Appearance" open={false} onToggle={() => {}} query="css" keywords="theme custom css typography">
        <p>body</p>
      </Accordion>
    );
    expect(screen.getByText("Appearance")).toBeInTheDocument();
  });

  it("force-opens a matching section while searching, even if open=false", () => {
    render(
      <Accordion title="Appearance" open={false} onToggle={() => {}} query="theme" keywords="theme">
        <p>body</p>
      </Accordion>
    );
    expect(screen.getByRole("button", { name: /Appearance/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("matches case-insensitively on the title", () => {
    render(
      <Accordion title="Backup & Restore" open={false} onToggle={() => {}} query="backup">
        <p>body</p>
      </Accordion>
    );
    expect(screen.getByText("Backup & Restore")).toBeInTheDocument();
  });
});
