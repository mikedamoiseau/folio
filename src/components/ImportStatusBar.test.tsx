import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import ImportStatusBar from "./ImportStatusBar";
import { useImport } from "../context/ImportContext";

vi.mock("../context/ImportContext", () => ({
  useImport: vi.fn(),
}));

const useImportMock = useImport as unknown as ReturnType<typeof vi.fn>;

describe("ImportStatusBar", () => {
  it("renders nothing when no progress is reported", () => {
    useImportMock.mockReturnValue({
      running: false,
      progress: null,
      lastCompletedAt: null,
      startFolder: vi.fn(),
      startFiles: vi.fn(),
      cancel: vi.fn(),
    });
    const html = renderToString(<ImportStatusBar />);
    expect(html).toBe("");
  });

  it("renders importing progress and a Cancel button while running", () => {
    useImportMock.mockReturnValue({
      running: true,
      progress: {
        phase: "importing",
        current: 3,
        total: 10,
        filename: "book.epub",
        imported: 2,
        duplicates: 0,
        errors: 1,
      },
      lastCompletedAt: null,
      startFolder: vi.fn(),
      startFiles: vi.fn(),
      cancel: vi.fn(),
    });
    const html = renderToString(<ImportStatusBar />);
    expect(html).toContain("library.importingProgress");
    expect(html).toContain("library.importingFile");
    expect(html).toContain("library.imported");
    expect(html).toContain("library.failed");
    expect(html).toContain("common.cancel");
  });

  it("renders skipped count when duplicates were detected", () => {
    useImportMock.mockReturnValue({
      running: true,
      progress: {
        phase: "importing",
        current: 6,
        total: 10,
        filename: "book.epub",
        imported: 4,
        duplicates: 2,
        errors: 0,
      },
      lastCompletedAt: null,
      startFolder: vi.fn(),
      startFiles: vi.fn(),
      cancel: vi.fn(),
    });
    const html = renderToString(<ImportStatusBar />);
    expect(html).toContain("library.skipped");
  });

  it("renders the done summary without a Cancel button after completion", () => {
    useImportMock.mockReturnValue({
      running: false,
      progress: {
        phase: "done",
        current: 5,
        total: 5,
        filename: "",
        imported: 4,
        duplicates: 0,
        errors: 1,
      },
      lastCompletedAt: 12345,
      startFolder: vi.fn(),
      startFiles: vi.fn(),
      cancel: vi.fn(),
    });
    const html = renderToString(<ImportStatusBar />);
    expect(html).toContain("library.importBackgroundDone");
    expect(html).not.toContain("common.cancel");
  });

  it("renders 'no supported files' message on empty terminal phase", () => {
    useImportMock.mockReturnValue({
      running: false,
      progress: {
        phase: "empty",
        current: 0,
        total: 0,
        filename: "/some/folder",
        imported: 0,
        duplicates: 0,
        errors: 0,
      },
      lastCompletedAt: null,
      startFolder: vi.fn(),
      startFiles: vi.fn(),
      cancel: vi.fn(),
    });
    const html = renderToString(<ImportStatusBar />);
    expect(html).toContain("library.noSupportedFiles");
    expect(html).not.toContain("common.cancel");
  });

  it("maps the raw backend error to friendly copy and offers Retry on the error phase", () => {
    useImportMock.mockReturnValue({
      running: false,
      progress: {
        phase: "error",
        current: 0,
        total: 0,
        filename: "IO: permission denied",
        imported: 0,
        duplicates: 0,
        errors: 0,
      },
      lastCompletedAt: null,
      startFolder: vi.fn(),
      startFiles: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      dismiss: vi.fn(),
    });
    const html = renderToString(<ImportStatusBar />);
    // raw "permission denied" mapped to a translation key, not surfaced verbatim
    expect(html).toContain("errors.permissionDenied");
    expect(html).toContain("library.retryImport");
    expect(html).not.toContain("common.cancel");
  });
});
