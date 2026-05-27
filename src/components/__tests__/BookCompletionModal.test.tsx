// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      const map: Record<string, string> = {
        "celebration.title": "Book Completed",
        "celebration.heading": "You finished it!",
        "celebration.byAuthor": `by ${opts?.author ?? ""}`,
        "celebration.totalReadingTime": "Total reading time",
        "celebration.ratePrompt": "How would you rate this book?",
        "celebration.ratingSubmitted": "Rating saved",
        "celebration.ratingFailed": "Failed to save rating",
        "celebration.ratingThanks": "Rating saved",
        "celebration.close": "Continue",
      };
      return map[key] ?? key;
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({})),
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

vi.mock("canvas-confetti", () => ({ default: vi.fn() }));

vi.mock("../Toast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock("../../lib/useFocusTrap", () => ({
  useFocusTrap: () => ({ current: null }),
}));

import { render, screen, cleanup, act } from "@testing-library/react";
import BookCompletionModal from "../BookCompletionModal";

afterEach(() => cleanup());

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const defaultProps = {
  bookId: "book-1",
  title: "Test Book",
  author: "Test Author",
  coverPath: "/covers/book-1.jpg",
  readingTimeSecs: 7200,
  onClose: vi.fn(),
};

describe("BookCompletionModal", () => {
  it("does not render before 1.5s delay", () => {
    render(<BookCompletionModal {...defaultProps} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders after 1.5s delay", () => {
    render(<BookCompletionModal {...defaultProps} />);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders title and author", () => {
    render(<BookCompletionModal {...defaultProps} />);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByText("You finished it!")).toBeInTheDocument();
    expect(screen.getByText("Test Book")).toBeInTheDocument();
    expect(screen.getByText("by Test Author")).toBeInTheDocument();
  });

  it("renders reading time", () => {
    render(<BookCompletionModal {...defaultProps} />);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByText("2h")).toBeInTheDocument();
  });

  it("hides reading time when zero", () => {
    render(<BookCompletionModal {...defaultProps} readingTimeSecs={0} />);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByText("Total reading time")).not.toBeInTheDocument();
  });

  it("renders cover image with convertFileSrc", () => {
    render(<BookCompletionModal {...defaultProps} />);
    act(() => { vi.advanceTimersByTime(1500); });
    const img = screen.getByRole("presentation");
    expect(img).toHaveAttribute("src", "asset:///covers/book-1.jpg");
  });

  it("renders fallback when no cover", () => {
    render(<BookCompletionModal {...defaultProps} coverPath={null} />);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByRole("presentation")).not.toBeInTheDocument();
  });

  it("renders star rating prompt", () => {
    render(<BookCompletionModal {...defaultProps} />);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByText("How would you rate this book?")).toBeInTheDocument();
  });

  it("calls onClose when Continue clicked", () => {
    const onClose = vi.fn();
    render(<BookCompletionModal {...defaultProps} onClose={onClose} />);
    act(() => { vi.advanceTimersByTime(1500); });
    screen.getByText("Continue").click();
    expect(onClose).toHaveBeenCalled();
  });

  it("fires confetti after becoming visible", async () => {
    const confetti = (await import("canvas-confetti")).default;
    render(<BookCompletionModal {...defaultProps} />);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(confetti).toHaveBeenCalled();
  });
});
