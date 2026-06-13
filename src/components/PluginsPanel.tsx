import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

interface PermissionView {
  id: string;
  category_key: string;
}

interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  events: string[];
  permissions: PermissionView[];
  status: "active" | "disabled" | "auto_disabled" | "invalid";
  invalid_reason: string | null;
  needs_consent: boolean;
}

interface ExamplePlugin {
  id: string;
  name: string;
  description: string;
  installed: boolean;
}

/**
 * Settings > Plugins. Lists installed plugins, gates enabling behind a
 * consent dialog that spells out each permission's data category, and offers
 * a gallery of bundled example plugins to install.
 */
export default function PluginsPanel({ onToast }: { onToast?: (msg: string) => void }) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [examples, setExamples] = useState<ExamplePlugin[]>([]);
  const [consentFor, setConsentFor] = useState<PluginView | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, ex] = await Promise.all([
        invoke<PluginView[]>("plugin_list"),
        invoke<ExamplePlugin[]>("plugin_list_examples"),
      ]);
      setPlugins(list);
      setExamples(ex);
    } catch (e) {
      onToast?.(String(e));
    }
  }, [onToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async (p: PluginView, next: boolean) => {
    if (next && p.needs_consent) {
      // Permissions not yet granted (new plugin, or manifest added a
      // permission) — show the consent dialog. Already-granted plugins
      // re-enable without re-prompting (spec §4.3).
      setConsentFor(p);
      return;
    }
    setBusy(true);
    try {
      if (next) {
        // Re-affirm the already-granted permissions; the backend requires
        // the grant set to match the manifest exactly.
        await invoke("plugin_enable", {
          pluginId: p.id,
          grantedPermissions: p.permissions.map((perm) => perm.id),
        });
      } else {
        await invoke("plugin_disable", { pluginId: p.id });
      }
      await refresh();
    } catch (e) {
      onToast?.(String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmConsent = async () => {
    if (!consentFor) return;
    const p = consentFor;
    setBusy(true);
    try {
      await invoke("plugin_enable", {
        pluginId: p.id,
        grantedPermissions: p.permissions.map((perm) => perm.id),
      });
      setConsentFor(null);
      await refresh();
    } catch (e) {
      onToast?.(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    try {
      await invoke("plugin_reload");
      await refresh();
    } catch (e) {
      onToast?.(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openDir = async () => {
    try {
      await invoke("plugin_open_dir");
    } catch (e) {
      onToast?.(String(e));
    }
  };

  const installExample = async (id: string) => {
    setBusy(true);
    try {
      await invoke("plugin_install_example", { exampleId: id });
      await refresh();
    } catch (e) {
      onToast?.(String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (p: PluginView) => {
    switch (p.status) {
      case "active":
        return t("plugins.statusActive");
      case "auto_disabled":
        return t("plugins.statusAutoDisabled");
      case "invalid":
        return t("plugins.statusInvalid");
      default:
        return t("plugins.statusDisabled");
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-ink-muted">{t("plugins.intro")}</p>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={reload}
          disabled={busy}
          className="text-accent hover:text-accent-hover hover:underline disabled:opacity-50"
        >
          {t("plugins.reload")}
        </button>
        <button
          type="button"
          onClick={openDir}
          className="text-accent hover:text-accent-hover hover:underline"
        >
          {t("plugins.openFolder")}
        </button>
      </div>

      {plugins.length === 0 ? (
        <p className="text-ink-muted">{t("plugins.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {plugins.map((p) => (
            <li key={p.id} className="rounded-xl bg-warm-subtle/60 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink truncate">{p.name}</span>
                    {p.version && (
                      <span className="text-xs text-ink-muted">v{p.version}</span>
                    )}
                  </div>
                  {p.description && (
                    <p className="text-ink-muted mt-0.5">{p.description}</p>
                  )}
                  <p className="text-xs text-ink-muted mt-1">
                    {statusLabel(p)}
                    {p.status === "invalid" && p.invalid_reason
                      ? ` — ${p.invalid_reason}`
                      : ""}
                  </p>
                </div>
                {p.status !== "invalid" && (
                  <label className="flex items-center gap-2 shrink-0">
                    <input
                      type="checkbox"
                      checked={p.status === "active"}
                      disabled={busy}
                      onChange={(e) => toggle(p, e.target.checked)}
                    />
                    <span className="sr-only">{t("plugins.enable")}</span>
                  </label>
                )}
              </div>
              {p.permissions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {p.permissions.map((perm) => (
                    <span
                      key={perm.id}
                      className="text-xs rounded-full bg-warm-border/40 px-2 py-0.5 text-ink-muted"
                    >
                      {t(`plugins.perm.${perm.category_key}`)}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {examples.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            {t("plugins.examplesHeading")}
          </h4>
          <ul className="space-y-2">
            {examples.map((ex) => (
              <li
                key={ex.id}
                className="flex items-start justify-between gap-3 rounded-lg bg-warm-subtle/40 p-2.5"
              >
                <div className="min-w-0">
                  <span className="text-ink">{ex.name}</span>
                  <p className="text-ink-muted text-xs mt-0.5">{ex.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => installExample(ex.id)}
                  disabled={busy || ex.installed}
                  className="shrink-0 text-accent hover:text-accent-hover hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-default"
                >
                  {ex.installed ? t("plugins.installed") : t("plugins.install")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {consentFor && (
        <>
          <div
            className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[60]"
            onClick={() => setConsentFor(null)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.consentTitle", { name: consentFor.name })}
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            <div className="w-full max-w-md rounded-2xl bg-paper p-5 shadow-xl space-y-4">
              <h3 className="font-semibold text-ink">
                {t("plugins.consentTitle", { name: consentFor.name })}
              </h3>
              <p className="text-ink-muted">{t("plugins.consentBody")}</p>
              <ul className="space-y-1.5">
                {consentFor.permissions.map((perm) => (
                  <li key={perm.id} className="flex gap-2 text-ink">
                    <span aria-hidden="true">•</span>
                    <span>{t(`plugins.perm.${perm.category_key}`)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink-muted">{t("plugins.consentTrust")}</p>
              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setConsentFor(null)}
                  className="text-ink-muted hover:text-ink"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={confirmConsent}
                  disabled={busy}
                  className="rounded-lg bg-accent px-4 py-1.5 text-paper hover:bg-accent-hover disabled:opacity-50"
                >
                  {t("plugins.consentApprove")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
