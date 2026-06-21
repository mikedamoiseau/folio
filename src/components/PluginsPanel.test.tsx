// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

const invoke = vi.fn();
const openDialog = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialog(...a) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import PluginsPanel from "./PluginsPanel";

beforeEach(() => {
  invoke.mockReset();
  openDialog.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "plugin_list") return Promise.resolve([]);
    if (cmd === "plugin_list_examples") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
});
afterEach(() => cleanup());

describe("PluginsPanel reload feedback", () => {
  it("fires a success toast after a successful reload", async () => {
    const onToast = vi.fn();
    render(<PluginsPanel onToast={onToast} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_list"));

    await act(async () => fireEvent.click(screen.getByText("plugins.reload")));

    expect(invoke).toHaveBeenCalledWith("plugin_reload");
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("plugins.reloadSuccess", "success")
    );
  });

  it("fires an error toast when reload fails", async () => {
    const onToast = vi.fn();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin_list") return Promise.resolve([]);
      if (cmd === "plugin_list_examples") return Promise.resolve([]);
      if (cmd === "plugin_reload") return Promise.reject(new Error("boom"));
      return Promise.resolve(undefined);
    });
    render(<PluginsPanel onToast={onToast} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_list"));

    await act(async () => fireEvent.click(screen.getByText("plugins.reload")));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining("boom"), "error")
    );
  });

  it("does not fire a success toast when the post-reload refresh fails", async () => {
    const onToast = vi.fn();
    let reloaded = false;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin_reload") {
        reloaded = true;
        return Promise.resolve(undefined);
      }
      // The refresh that runs after a successful reload fails.
      if (cmd === "plugin_list") {
        return reloaded
          ? Promise.reject(new Error("list-fail"))
          : Promise.resolve([]);
      }
      if (cmd === "plugin_list_examples") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    render(<PluginsPanel onToast={onToast} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_list"));

    await act(async () => fireEvent.click(screen.getByText("plugins.reload")));

    // refresh() surfaced its own error toast...
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining("list-fail"))
    );
    // ...and the success toast never fired despite plugin_reload succeeding.
    expect(onToast).not.toHaveBeenCalledWith("plugins.reloadSuccess", "success");
  });
});

describe("PluginsPanel install feedback", () => {
  it("fires a success toast after installing an example plugin", async () => {
    const onToast = vi.fn();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin_list") return Promise.resolve([]);
      if (cmd === "plugin_list_examples")
        return Promise.resolve([
          { id: "ex1", name: "Example One", description: "desc", installed: false },
        ]);
      return Promise.resolve(undefined);
    });
    render(<PluginsPanel onToast={onToast} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_list_examples"));

    await act(async () => fireEvent.click(screen.getByText("plugins.install")));

    expect(invoke).toHaveBeenCalledWith("plugin_install_example", { exampleId: "ex1" });
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("plugins.installSuccess", "success")
    );
  });

  it("does not fire a success toast when the post-install refresh fails", async () => {
    const onToast = vi.fn();
    let installed = false;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin_install_example") {
        installed = true;
        return Promise.resolve(undefined);
      }
      // The refresh that runs after a successful install fails.
      if (cmd === "plugin_list") {
        return installed
          ? Promise.reject(new Error("list-fail"))
          : Promise.resolve([]);
      }
      if (cmd === "plugin_list_examples")
        return Promise.resolve([
          { id: "ex1", name: "Example One", description: "desc", installed: false },
        ]);
      return Promise.resolve(undefined);
    });
    render(<PluginsPanel onToast={onToast} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_list_examples"));

    await act(async () => fireEvent.click(screen.getByText("plugins.install")));

    expect(invoke).toHaveBeenCalledWith("plugin_install_example", { exampleId: "ex1" });
    // refresh() surfaced its own error toast...
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining("list-fail"))
    );
    // ...and the success toast never fired despite the install succeeding.
    expect(onToast).not.toHaveBeenCalledWith("plugins.installSuccess", "success");
  });
});

describe("PluginsPanel write:files writability check", () => {
  const writeFilesPlugin = {
    id: "wf",
    name: "Writer",
    version: "1.0.0",
    description: "",
    author: "",
    events: [],
    permissions: [{ id: "write:files", category_key: "writeFiles" }],
    network_hosts: [],
    status: "disabled" as const,
    invalid_reason: null,
    needs_consent: true,
    can_run_now: false,
  };

  it("aborts and errors when the chosen folder is not writable", async () => {
    const onToast = vi.fn();
    openDialog.mockResolvedValue("/some/unwritable/dir");
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin_list") return Promise.resolve([writeFilesPlugin]);
      if (cmd === "plugin_list_examples") return Promise.resolve([]);
      if (cmd === "check_dir_writable") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });
    render(<PluginsPanel onToast={onToast} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_list"));

    // Toggling the disabled plugin on opens the consent dialog.
    await act(async () => fireEvent.click(screen.getByRole("checkbox")));
    await act(async () =>
      fireEvent.click(screen.getByText("plugins.consentApprove"))
    );

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("plugins.folderNotWritable", "error")
    );
    // The writability check ran but the plugin was never enabled.
    expect(invoke).toHaveBeenCalledWith("check_dir_writable", {
      path: "/some/unwritable/dir",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "plugin_enable",
      expect.anything()
    );
  });

  it("enables the plugin when the chosen folder is writable", async () => {
    const onToast = vi.fn();
    openDialog.mockResolvedValue("/some/writable/dir");
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin_list") return Promise.resolve([writeFilesPlugin]);
      if (cmd === "plugin_list_examples") return Promise.resolve([]);
      if (cmd === "check_dir_writable") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    render(<PluginsPanel onToast={onToast} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin_list"));

    await act(async () => fireEvent.click(screen.getByRole("checkbox")));
    await act(async () =>
      fireEvent.click(screen.getByText("plugins.consentApprove"))
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin_enable", {
        pluginId: "wf",
        grants: [{ permission: "write:files", params: "/some/writable/dir" }],
      })
    );
    expect(onToast).not.toHaveBeenCalledWith(
      "plugins.folderNotWritable",
      "error"
    );
  });
});
