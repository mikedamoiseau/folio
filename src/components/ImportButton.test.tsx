// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k),
  }),
}));

import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import ImportButton from "./ImportButton";

afterEach(() => cleanup());

async function openUrlDialog() {
  // Open the dropdown menu, then the URL dialog.
  await act(async () => fireEvent.click(screen.getByText("import.addBooks")));
  await act(async () => fireEvent.click(screen.getByText("import.importFromUrl")));
}

describe("ImportButton URL import", () => {
  it("shows an inline error and does not invoke the backend for a non-http URL", async () => {
    const onImportUrl = vi.fn();
    render(
      <ImportButton onImportFiles={() => {}} onImportFolder={() => {}} onImportUrl={onImportUrl} />,
    );
    await openUrlDialog();

    const input = screen.getByPlaceholderText("import.urlPlaceholder");
    await act(async () => fireEvent.change(input, { target: { value: "ftp://example.com/book.epub" } }));
    await act(async () => fireEvent.click(screen.getByText("common.import")));

    expect(onImportUrl).not.toHaveBeenCalled();
    expect(screen.getByText("import.invalidUrl")).toBeInTheDocument();
  });

  it("clears the inline error when the user edits the URL", async () => {
    render(
      <ImportButton onImportFiles={() => {}} onImportFolder={() => {}} onImportUrl={() => {}} />,
    );
    await openUrlDialog();

    const input = screen.getByPlaceholderText("import.urlPlaceholder");
    await act(async () => fireEvent.change(input, { target: { value: "not-a-url" } }));
    await act(async () => fireEvent.click(screen.getByText("common.import")));
    expect(screen.getByText("import.invalidUrl")).toBeInTheDocument();

    await act(async () => fireEvent.change(input, { target: { value: "https://example.com/b.epub" } }));
    expect(screen.queryByText("import.invalidUrl")).not.toBeInTheDocument();
  });

  it("surfaces a friendly error when the backend import rejects, keeping the dialog open", async () => {
    const onImportUrl = vi.fn().mockRejectedValue("network error");
    render(
      <ImportButton onImportFiles={() => {}} onImportFolder={() => {}} onImportUrl={onImportUrl} />,
    );
    await openUrlDialog();

    const input = screen.getByPlaceholderText("import.urlPlaceholder");
    await act(async () => fireEvent.change(input, { target: { value: "https://example.com/book.epub" } }));
    await act(async () => fireEvent.click(screen.getByText("common.import")));

    expect(onImportUrl).toHaveBeenCalledWith("https://example.com/book.epub");
    // "network error" maps through friendlyError -> errors.networkError translation key.
    await waitFor(() => expect(screen.getByText("errors.networkError")).toBeInTheDocument());
    // Dialog stays open: the URL input is still present.
    expect(screen.getByPlaceholderText("import.urlPlaceholder")).toBeInTheDocument();
  });

  it("closes the dialog on a successful import", async () => {
    const onImportUrl = vi.fn().mockResolvedValue(undefined);
    render(
      <ImportButton onImportFiles={() => {}} onImportFolder={() => {}} onImportUrl={onImportUrl} />,
    );
    await openUrlDialog();

    const input = screen.getByPlaceholderText("import.urlPlaceholder");
    await act(async () => fireEvent.change(input, { target: { value: "https://example.com/book.epub" } }));
    await act(async () => fireEvent.click(screen.getByText("common.import")));

    expect(onImportUrl).toHaveBeenCalledWith("https://example.com/book.epub");
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("import.urlPlaceholder")).not.toBeInTheDocument(),
    );
  });
});
