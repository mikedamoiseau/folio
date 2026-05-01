// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import OpdsPresetPicker from "./OpdsPresetPicker";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string) => k,
  }),
}));

vi.mock("../data/opds-presets.json", () => ({
  default: [
    {
      id: "p1",
      name: "Project Gutenberg",
      url: "https://gutenberg.org/opds",
      languages: ["en", "multi"],
      categories: ["public-domain", "literature"],
      description: "Public domain ebooks",
    },
    {
      id: "p2",
      name: "Gallica",
      url: "https://gallica.bnf.fr/opds",
      languages: ["fr"],
      categories: ["public-domain", "academic"],
      description: "French national library",
    },
  ],
}));

import { invoke } from "@tauri-apps/api/core";

describe("OpdsPresetPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  const props = {
    currentCatalogs: [],
    onClose: vi.fn(),
    onAdded: vi.fn(),
  };

  it("renders all presets when no filters set", () => {
    render(<OpdsPresetPicker {...props} />);
    expect(screen.getByText("Project Gutenberg")).toBeInTheDocument();
    expect(screen.getByText("Gallica")).toBeInTheDocument();
  });

  it("filters by search query", () => {
    render(<OpdsPresetPicker {...props} />);
    const input = screen.getByPlaceholderText("catalog.presets.searchPlaceholder");
    fireEvent.change(input, { target: { value: "gallica" } });
    expect(screen.queryByText("Project Gutenberg")).not.toBeInTheDocument();
    expect(screen.getByText("Gallica")).toBeInTheDocument();
  });

  it("shows Added badge for already-added presets", () => {
    render(
      <OpdsPresetPicker
        {...props}
        currentCatalogs={[
          { name: "Project Gutenberg", url: "https://gutenberg.org/opds", presetId: "p1" },
        ]}
      />,
    );
    const gutenbergRow = screen.getByText("Project Gutenberg").closest("[data-preset-id]");
    expect(gutenbergRow).toHaveAttribute("data-preset-id", "p1");
    // The Added badge contains the t() key with a leading checkmark.
    // Use a regex so the checkmark prefix doesn't break the match.
    const addedBadges = screen.getAllByText(/catalog\.presets\.added/);
    expect(addedBadges.length).toBeGreaterThan(0);
  });

  it("invokes add_opds_catalog with name, url, presetId on Add click", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    render(<OpdsPresetPicker {...props} />);

    const gallicaRow = screen.getByText("Gallica").closest("[data-preset-id='p2']");
    expect(gallicaRow).not.toBeNull();
    const addBtn = gallicaRow!.querySelector("button[data-action='add']");
    expect(addBtn).not.toBeNull();
    fireEvent.click(addBtn as HTMLElement);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("add_opds_catalog", {
        name: "Gallica",
        url: "https://gallica.bnf.fr/opds",
        presetId: "p2",
      });
    });
    expect(props.onAdded).toHaveBeenCalled();
  });

  it("toggles language filter chip", () => {
    render(<OpdsPresetPicker {...props} />);
    // Click the chip-row "fr" button. Two elements have the lang.fr label
    // (chip + per-row badge); the chip is the first interactive button.
    const frButtons = screen.getAllByRole("button", { name: /catalog\.presets\.lang\.fr/ });
    const frChip = frButtons[0];
    fireEvent.click(frChip);
    expect(screen.queryByText("Project Gutenberg")).not.toBeInTheDocument();
    expect(screen.getByText("Gallica")).toBeInTheDocument();
  });

  it("shows empty state when no presets match", () => {
    render(<OpdsPresetPicker {...props} />);
    fireEvent.change(screen.getByPlaceholderText("catalog.presets.searchPlaceholder"), {
      target: { value: "zzznotamatch" },
    });
    expect(screen.getByText("catalog.presets.empty")).toBeInTheDocument();
  });
});
