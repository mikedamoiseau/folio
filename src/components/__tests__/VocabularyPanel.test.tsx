// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import en from "../../locales/en.json";
import type { VocabularyWord } from "../../lib/vocabulary";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string | number>) => {
      const parts = key.split(".");
      let val: unknown = en;
      for (const p of parts) val = (val as Record<string, unknown>)?.[p];
      let str = typeof val === "string" ? val : key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        }
      }
      return str;
    },
  }),
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../../lib/useFocusTrap", () => ({
  useFocusTrap: () => ({ current: null }),
}));

const sampleWord: VocabularyWord = {
  id: "v1",
  lemma: "run",
  word: "running",
  pos: "v",
  definition: "to move fast",
  bookId: "book-1",
  bookTitle: "Test Book",
  chapterIndex: 2,
  contextSentence: "She was running.",
  startOffset: 10,
  endOffset: 17,
  seenCount: 1,
  box: 1,
  lastReviewedAt: null,
  nextDueAt: null,
  lastSeenAt: 1_700_000_000,
  createdAt: 1_700_000_000,
};

const invokeMock = vi.fn((cmd: string) => {
  if (cmd === "list_vocabulary") return Promise.resolve([sampleWord]);
  if (cmd === "get_due_vocabulary") return Promise.resolve([]);
  if (cmd === "delete_vocabulary_word") return Promise.resolve(undefined);
  return Promise.resolve(undefined);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, ...args: unknown[]) => invokeMock(cmd, ...args),
}));

import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import VocabularyPanel from "../VocabularyPanel";

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VocabularyPanel — F-1-5 fix 4: keyboard delete must not trigger jump", () => {
  it("deleting via Enter on the delete button deletes only, without navigating", async () => {
    render(<VocabularyPanel onClose={vi.fn()} />);

    const deleteButton = await screen.findByLabelText("Delete “running”");
    deleteButton.focus();
    // jsdom doesn't synthesize a button's native "Enter triggers click"
    // behavior, so this fires both halves of what a real browser does for a
    // focused button on Enter: the keydown (which bubbles to the row — the
    // exact bubbling the row's handler must ignore) and the resulting click
    // (which the delete button's own handler, unrelated to this fix,
    // already stops from propagating).
    fireEvent.keyDown(deleteButton, { key: "Enter" });
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("delete_vocabulary_word", { id: "v1" });
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("pressing Enter on the row itself still jumps", async () => {
    render(<VocabularyPanel onClose={vi.fn()} />);

    const row = (await screen.findByText("running")).closest('[role="button"]');
    expect(row).not.toBeNull();
    fireEvent.keyDown(row as Element, { key: "Enter" });

    expect(mockNavigate).toHaveBeenCalledWith(
      "/reader/book-1",
      { state: { chapterIndex: 2, offset: 10 } },
    );
  });
});
