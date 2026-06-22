// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { error?: string }) => {
      const map: Record<string, string> = {
        "common.retry": "Retry",
        "reader.failedToLoadChapter": `Failed to load chapter: ${opts?.error ?? ""}`,
      };
      return map[key] ?? key;
    },
  }),
}));

import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import ChapterErrorCard from "./ChapterErrorCard";

afterEach(() => cleanup());

describe("ChapterErrorCard", () => {
  it("shows the error detail and a retry control", () => {
    render(<ChapterErrorCard error="boom" onRetry={() => {}} />);
    expect(screen.getByText("Failed to load chapter: boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("invokes onRetry when the retry button is clicked", () => {
    const onRetry = vi.fn();
    render(<ChapterErrorCard error="boom" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
