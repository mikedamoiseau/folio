// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k) }),
}));
vi.mock("../lib/supportedFormats", () => ({
  FALLBACK_FORMATS: ["epub"],
  useSupportedFormats: () => ["epub", "pdf"],
}));
vi.mock("./OpdsPresetPicker", () => ({ default: () => null }));
vi.mock("../lib/useFocusTrap", () => ({ useFocusTrap: () => ({ current: null }) }));

import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import CatalogBrowser from "./CatalogBrowser";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "get_opds_catalogs") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
});
afterEach(() => cleanup());

async function openAddForm() {
  render(<CatalogBrowser onClose={() => {}} onBookImported={() => {}} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_opds_catalogs"));
  // Reveal the add-catalog form
  const addToggle = await screen.findByText("catalog.addCustomCatalog");
  await act(async () => fireEvent.click(addToggle));
}

async function fillForm(name: string, url: string) {
  const nameInput = screen.getByPlaceholderText("catalog.catalogName");
  const urlInput = screen.getByPlaceholderText("catalog.opdsFeedUrl");
  await act(async () => {
    fireEvent.change(nameInput, { target: { value: name } });
    fireEvent.change(urlInput, { target: { value: url } });
  });
}

describe("CatalogBrowser add-catalog validation", () => {
  it("rejects an invalid URL without calling the backend", async () => {
    await openAddForm();
    await fillForm("My Feed", "not-a-url");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "common.add" })));

    expect(invoke).not.toHaveBeenCalledWith("browse_opds", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("add_opds_catalog", expect.anything());
    expect(screen.getByText("catalog.invalidUrl")).toBeInTheDocument();
  });

  it("saves then connection-tests via browse_opds for a valid URL (no rollback on success)", async () => {
    await openAddForm();
    await fillForm("My Feed", "https://example.com/opds");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "common.add" })));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("browse_opds", { url: "https://example.com/opds" }));
    expect(invoke).toHaveBeenCalledWith("add_opds_catalog", { name: "My Feed", url: "https://example.com/opds" });
    // success → no rollback
    expect(invoke).not.toHaveBeenCalledWith("remove_opds_catalog", expect.anything());
  });

  it("rolls back the add when the connection test fails", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_opds_catalogs") return Promise.resolve([]);
      if (cmd === "browse_opds") return Promise.reject(new Error("connection refused"));
      return Promise.resolve(undefined);
    });
    await openAddForm();
    await fillForm("Broken", "https://bad.example/opds");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "common.add" })));

    await waitFor(() => expect(screen.getByText(/catalog\.connectionTestFailed/)).toBeInTheDocument());
    // it was provisionally added, then rolled back
    expect(invoke).toHaveBeenCalledWith("add_opds_catalog", { name: "Broken", url: "https://bad.example/opds" });
    expect(invoke).toHaveBeenCalledWith("remove_opds_catalog", { url: "https://bad.example/opds" });
  });
});

describe("CatalogBrowser empty state", () => {
  it("shows the no-catalogs empty state only after a successful empty load, not while loading", async () => {
    // Hold the load open so we can assert the empty state is NOT shown until
    // `get_opds_catalogs` resolves (i.e. it must not flash on initial load).
    let resolveCatalogs!: (v: unknown[]) => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_opds_catalogs")
        return new Promise((res) => {
          resolveCatalogs = res as (v: unknown[]) => void;
        });
      return Promise.resolve(undefined);
    });
    render(<CatalogBrowser onClose={() => {}} onBookImported={() => {}} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_opds_catalogs"));

    // While the load is still pending, the empty state must not appear.
    expect(screen.queryByText("catalog.empty.title")).not.toBeInTheDocument();

    // Resolve the load to an empty list — now the empty state appears.
    await act(async () => {
      resolveCatalogs([]);
    });

    expect(await screen.findByText("catalog.empty.title")).toBeInTheDocument();
    expect(screen.getByText("catalog.empty.subtitle")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "catalog.empty.browsePresets" })
    ).toBeInTheDocument();
  });

  it("does not show the empty state after a failed load", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_opds_catalogs") return Promise.reject(new Error("boom"));
      return Promise.resolve(undefined);
    });
    render(<CatalogBrowser onClose={() => {}} onBookImported={() => {}} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_opds_catalogs"));

    // Load failed → `catalogsLoaded` stays false → empty state hidden even
    // though `catalogs` is still [].
    expect(screen.queryByText("catalog.empty.title")).not.toBeInTheDocument();
  });

  it("hides the empty state once a catalog exists", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_opds_catalogs")
        return Promise.resolve([{ name: "My Feed", url: "https://example.com/opds" }]);
      return Promise.resolve(undefined);
    });
    render(<CatalogBrowser onClose={() => {}} onBookImported={() => {}} />);
    await waitFor(() => expect(screen.getByText("My Feed")).toBeInTheDocument());

    expect(screen.queryByText("catalog.empty.title")).not.toBeInTheDocument();
  });
});

describe("CatalogBrowser remove confirmation", () => {
  it("confirms before removing a catalog (no immediate backend call)", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_opds_catalogs")
        return Promise.resolve([{ name: "My Feed", url: "https://example.com/opds" }]);
      return Promise.resolve(undefined);
    });
    render(<CatalogBrowser onClose={() => {}} onBookImported={() => {}} />);
    await waitFor(() => expect(screen.getByText("My Feed")).toBeInTheDocument());

    await act(async () => fireEvent.click(screen.getByLabelText(/catalog\.removeCatalog/)));
    expect(invoke).not.toHaveBeenCalledWith("remove_opds_catalog", expect.anything());
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "common.remove" })));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("remove_opds_catalog", { url: "https://example.com/opds" })
    );
  });
});
