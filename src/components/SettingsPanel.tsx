import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../context/ThemeContext";
import ActivityLog from "./ActivityLog";

function Accordion({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-1 group"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {title}
        </h3>
        <svg
          width="12"
          height="12"
          viewBox="0 0 20 20"
          fill="none"
          className={`text-ink-muted/50 group-hover:text-ink-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </section>
  );
}

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

interface LibraryFolderInfo {
  path: string;
  file_count: number;
  total_size_bytes: number;
}

interface ConfigField {
  key: string;
  label: string;
  fieldType: string;
  required: boolean;
  placeholder: string;
}

interface ProviderInfo {
  providerType: string;
  label: string;
  fields: ConfigField[];
}

interface EnrichmentProviderInfo {
  id: string;
  name: string;
  requiresApiKey: boolean;
  apiKeyHelp: string;
  config: {
    enabled: boolean;
    apiKey: string | null;
  };
}

interface BackupConfig {
  providerType: string;
  values: Record<string, string>;
}

interface SyncResult {
  booksPushed: number;
  progressPushed: number;
  bookmarksPushed: number;
  highlightsPushed: number;
  collectionsPushed: number;
  filesPushed: number;
}

interface SyncManifest {
  lastSyncAt: number;
  deviceId: string;
}

interface MigrationDialogState {
  currentFolder: string;
  newFolder: string;
  fileCount: number;
  totalSizeBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const { mode, setMode, fontSize, setFontSize, fontFamily, setFontFamily } =
    useTheme();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // Library folder state
  const [libraryFolder, setLibraryFolder] = useState<string | null>(null);
  const [libraryInfo, setLibraryInfo] = useState<LibraryFolderInfo | null>(null);
  const [migrationDialog, setMigrationDialog] = useState<MigrationDialogState | null>(null);
  const [dontMoveFiles, setDontMoveFiles] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [includeFiles, setIncludeFiles] = useState(false);

  // Metadata scan settings
  const [autoScanImport, setAutoScanImport] = useState(true);
  const [autoScanStartup, setAutoScanStartup] = useState(false);

  // Enrichment providers
  const [enrichmentProviders, setEnrichmentProviders] = useState<EnrichmentProviderInfo[]>([]);

  // Activity log state
  const [showActivityLog, setShowActivityLog] = useState(false);

  // Remote backup state
  const [backupProviders, setBackupProviders] = useState<ProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [backupFieldValues, setBackupFieldValues] = useState<Record<string, string>>({});
  const [savedBackupConfig, setSavedBackupConfig] = useState<BackupConfig | null>(null);
  const [savingBackupConfig, setSavingBackupConfig] = useState(false);
  const [runningBackup, setRunningBackup] = useState(false);
  const [backupStatus, setBackupStatus] = useState<SyncManifest | null>(null);
  const [remoteBackupMessage, setRemoteBackupMessage] = useState<string | null>(null);

  const loadLibraryFolder = useCallback(async () => {
    try {
      const folder = await invoke<string>("get_library_folder");
      setLibraryFolder(folder);
      const info = await invoke<LibraryFolderInfo>("get_library_folder_info");
      setLibraryInfo(info);
    } catch (e) {
      console.error('Failed to load library folder:', e);
    }
  }, []);

  const loadBackupSettings = useCallback(async () => {
    try {
      const providers = await invoke<ProviderInfo[]>("get_backup_providers");
      setBackupProviders(providers);
      const config = await invoke<BackupConfig | null>("get_backup_config");
      if (config) {
        setSavedBackupConfig(config);
        setSelectedProvider(config.providerType);
        setBackupFieldValues(config.values);
      } else if (providers.length > 0) {
        setSelectedProvider(providers[0].providerType);
      }
      const status = await invoke<SyncManifest | null>("get_backup_status");
      setBackupStatus(status);
    } catch (e) {
      console.error('Failed to load backup settings:', e);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const providers = await invoke<EnrichmentProviderInfo[]>("get_enrichment_providers");
      setEnrichmentProviders(providers);
    } catch {}
  }, []);

  useEffect(() => {
    if (open) {
      loadLibraryFolder();
      loadBackupSettings();
      loadProviders();
      (async () => {
        const scanImport = await invoke<string | null>("get_setting_value", { key: "auto_scan_import" });
        setAutoScanImport(scanImport !== "false");
        const scanStartup = await invoke<string | null>("get_setting_value", { key: "auto_scan_startup" });
        setAutoScanStartup(scanStartup === "true");
      })().catch(() => {});
    }
  }, [open, loadLibraryFolder, loadBackupSettings, loadProviders]);

  useEffect(() => {
    if (!open) return;

    previousFocus.current = document.activeElement as HTMLElement;
    requestAnimationFrame(() => panelRef.current?.focus());

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (migrationDialog) {
          setMigrationDialog(null);
          setMigrationError(null);
          return;
        }
        onClose();
        return;
      }

      if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus.current?.focus();
    };
  }, [open, onClose, migrationDialog]);

  const handleChangeFolder = async () => {
    try {
      const picked = await openFolderPicker({ directory: true });
      if (!picked) return;

      const newFolder = typeof picked === "string" ? picked : picked[0];
      if (!newFolder) return;

      const info = await invoke<LibraryFolderInfo>("get_library_folder_info");
      setDontMoveFiles(false);
      setMigrationError(null);
      setMigrationDialog({
        currentFolder: info.path,
        newFolder,
        fileCount: info.file_count,
        totalSizeBytes: info.total_size_bytes,
      });
    } catch (err) {
      // Folder picker cancelled or command unavailable
    }
  };

  const handleConfirmMigration = async () => {
    if (!migrationDialog) return;
    setMigrating(true);
    setMigrationError(null);
    try {
      await invoke("set_library_folder", {
        newFolder: migrationDialog.newFolder,
        moveFiles: !dontMoveFiles,
      });
      setLibraryFolder(migrationDialog.newFolder);
      setMigrationDialog(null);
    } catch (err) {
      setMigrationError(String(err));
    } finally {
      setMigrating(false);
    }
  };

  const handleCancelMigration = () => {
    if (migrating) return;
    setMigrationDialog(null);
    setMigrationError(null);
  };

  const handleExport = async () => {
    try {
      const dest = await openFolderPicker({
        directory: true,
      });
      if (!dest) return;
      setExporting(true);
      setBackupMessage(null);
      const folder = typeof dest === "string" ? dest : dest[0];
      const path = `${folder}/folio-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      await invoke("export_library", { destPath: path, includeFiles });
      setBackupMessage(`Exported to ${path}`);
    } catch (err) {
      setBackupMessage(`Export failed: ${err}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImportBackup = async () => {
    try {
      const selected = await openFolderPicker({
        multiple: false,
        filters: [{ name: "Backup", extensions: ["zip"] }],
      } as Parameters<typeof openFolderPicker>[0]);
      if (!selected) return;
      setExporting(true);
      setBackupMessage(null);
      const path = typeof selected === "string" ? selected : selected[0];
      const count = await invoke<number>("import_library_backup", { archivePath: path });
      setBackupMessage(`Imported ${count} books from backup.`);
    } catch (err) {
      setBackupMessage(`Import failed: ${err}`);
    } finally {
      setExporting(false);
    }
  };

  const currentProviderInfo = backupProviders.find(
    (p) => p.providerType === selectedProvider
  );

  const handleProviderChange = (providerType: string) => {
    setSelectedProvider(providerType);
    setBackupFieldValues({});
    setRemoteBackupMessage(null);
  };

  const handleSaveBackupConfig = async () => {
    if (!selectedProvider || !currentProviderInfo) return;
    // Validate required fields
    const missing = currentProviderInfo.fields.filter(
      (f) => f.required && !backupFieldValues[f.key]?.trim()
    );
    if (missing.length > 0) {
      setRemoteBackupMessage(`Required: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    setSavingBackupConfig(true);
    setRemoteBackupMessage(null);
    try {
      const config: BackupConfig = {
        providerType: selectedProvider,
        values: backupFieldValues,
      };
      await invoke("save_backup_config", { config });
      setSavedBackupConfig(config);
      setRemoteBackupMessage("Configuration saved.");
    } catch (err) {
      setRemoteBackupMessage(`Save failed: ${err}`);
    } finally {
      setSavingBackupConfig(false);
    }
  };

  const handleRunBackup = async () => {
    setRunningBackup(true);
    setRemoteBackupMessage(null);
    try {
      const result = await invoke<SyncResult>("run_backup");
      const parts: string[] = [];
      if (result.booksPushed > 0) parts.push(`${result.booksPushed} books`);
      if (result.progressPushed > 0) parts.push(`${result.progressPushed} progress entries`);
      if (result.bookmarksPushed > 0) parts.push(`${result.bookmarksPushed} bookmarks`);
      if (result.highlightsPushed > 0) parts.push(`${result.highlightsPushed} highlights`);
      if (result.collectionsPushed > 0) parts.push(`${result.collectionsPushed} collections`);
      if (result.filesPushed > 0) parts.push(`${result.filesPushed} files`);
      const summary =
        parts.length > 0 ? `Backed up: ${parts.join(", ")}.` : "Everything already up to date.";
      setRemoteBackupMessage(summary);
      const status = await invoke<SyncManifest | null>("get_backup_status");
      setBackupStatus(status);
    } catch (err) {
      setRemoteBackupMessage(`Backup failed: ${err}`);
    } finally {
      setRunningBackup(false);
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-ink/20 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Reading settings"
        aria-modal="true"
        tabIndex={-1}
        className="fixed right-0 top-0 bottom-0 w-80 max-w-[90vw] bg-surface border-l border-warm-border z-50 flex flex-col shadow-[-4px_0_24px_-4px_rgba(44,34,24,0.12)] outline-none animate-slide-in-right"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
          <h2 className="font-serif text-base font-semibold text-ink">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-ink-muted hover:text-ink transition-colors rounded focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            aria-label="Close settings"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Settings content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-7">
          {/* Theme */}
          <Accordion title="Appearance" defaultOpen>
            <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
              {(["light", "dark", "system"] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => setMode(option)}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg capitalize transition-all duration-150 ${
                    mode === option
                      ? "bg-surface text-ink shadow-sm font-medium"
                      : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </Accordion>

          {/* Font size */}
          <Accordion title="Font Size" defaultOpen>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setFontSize(fontSize - 1)}
                disabled={fontSize <= MIN_FONT_SIZE}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-warm-subtle text-ink-muted hover:text-ink hover:bg-warm-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                aria-label="Decrease font size"
              >
                −
              </button>
              <div className="flex-1 flex flex-col items-center gap-1">
                <input
                  type="range"
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className="w-full accent-accent"
                  aria-label="Font size"
                  aria-valuetext={`${fontSize} pixels`}
                />
                <span className="text-xs text-ink-muted tabular-nums">
                  {fontSize}px
                </span>
              </div>
              <button
                onClick={() => setFontSize(fontSize + 1)}
                disabled={fontSize >= MAX_FONT_SIZE}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-warm-subtle text-ink-muted hover:text-ink hover:bg-warm-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                aria-label="Increase font size"
              >
                +
              </button>
            </div>
          </Accordion>

          {/* Font family */}
          <Accordion title="Reading Font" defaultOpen>
            <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
              {(["serif", "sans-serif"] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => setFontFamily(option)}
                  className={`flex-1 px-3 py-2.5 text-sm rounded-lg transition-all duration-150 ${
                    fontFamily === option
                      ? "bg-surface text-ink shadow-sm font-medium"
                      : "text-ink-muted hover:text-ink"
                  }`}
                  style={{
                    fontFamily:
                      option === "serif"
                        ? '"Lora", Georgia, serif'
                        : '"DM Sans", system-ui, sans-serif',
                  }}
                >
                  {option === "serif" ? "Lora" : "DM Sans"}
                </button>
              ))}
            </div>
            <p
              className="mt-3 text-sm text-ink-muted leading-relaxed"
              style={{
                fontFamily:
                  fontFamily === "serif"
                    ? '"Lora", Georgia, serif'
                    : '"DM Sans", system-ui, sans-serif',
              }}
            >
              The quick brown fox jumps over the lazy dog.
            </p>
          </Accordion>

          {/* Library */}
          <Accordion title="Library">
            <div className="space-y-2">
              <div className="bg-warm-subtle rounded-xl px-3 py-2.5">
                <p className="text-xs text-ink-muted mb-0.5">Storage folder</p>
                <p className="text-sm text-ink break-all leading-snug font-mono">
                  {libraryFolder ?? "—"}
                </p>
                {libraryInfo && (
                  <p className="text-xs text-ink-muted mt-1.5">
                    {libraryInfo.file_count} {libraryInfo.file_count === 1 ? "book" : "books"} · {formatBytes(libraryInfo.total_size_bytes)}
                  </p>
                )}
              </div>
              <button
                onClick={handleChangeFolder}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
              >
                Change folder…
              </button>
            </div>
          </Accordion>

          {/* Backup & Restore */}
          <Accordion title="Backup & Restore">
            <div className="space-y-2">
              <label className="flex items-start gap-2.5 cursor-pointer px-1">
                <input
                  type="checkbox"
                  checked={includeFiles}
                  onChange={(e) => setIncludeFiles(e.target.checked)}
                  disabled={exporting}
                  className="mt-0.5 accent-accent"
                />
                <span className="text-sm text-ink leading-snug">
                  Include book files
                  <span className="block text-xs text-ink-muted mt-0.5">
                    {includeFiles
                      ? "Full backup — metadata + all book files (can be large)"
                      : "Metadata only — progress, collections, tags, highlights (small)"}
                  </span>
                </span>
              </label>
              <button
                onClick={handleExport}
                disabled={exporting}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left disabled:opacity-40"
              >
                {exporting ? "Working…" : "Export library backup…"}
              </button>
              <button
                onClick={handleImportBackup}
                disabled={exporting}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left disabled:opacity-40"
              >
                Import from backup…
              </button>
              {backupMessage && (
                <p className="text-xs text-ink-muted px-1">{backupMessage}</p>
              )}
            </div>
          </Accordion>

          {/* Metadata Scan */}
          <Accordion title="Metadata Scan">
            <div className="space-y-2">
              <label className="flex items-start gap-2.5 cursor-pointer px-1">
                <input type="checkbox" checked={autoScanImport}
                  onChange={async (e) => {
                    const val = e.target.checked;
                    setAutoScanImport(val);
                    await invoke("set_setting_value", { key: "auto_scan_import", value: val ? "true" : "false" }).catch(() => {});
                  }}
                  className="mt-0.5 accent-accent" />
                <span className="text-sm text-ink leading-snug">
                  Auto-scan on import
                  <span className="block text-xs text-ink-muted mt-0.5">Automatically look up metadata when importing new books</span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer px-1">
                <input type="checkbox" checked={autoScanStartup}
                  onChange={async (e) => {
                    const val = e.target.checked;
                    setAutoScanStartup(val);
                    await invoke("set_setting_value", { key: "auto_scan_startup", value: val ? "true" : "false" }).catch(() => {});
                  }}
                  className="mt-0.5 accent-accent" />
                <span className="text-sm text-ink leading-snug">
                  Auto-scan on startup
                  <span className="block text-xs text-ink-muted mt-0.5">Scan unenriched books when the app starts</span>
                </span>
              </label>
              {enrichmentProviders.length > 0 && (
                <div className="mt-3">
                  <h4 className="text-xs font-medium text-ink-muted mb-2">Enrichment Sources</h4>
                  {enrichmentProviders.map((provider) => (
                    <div key={provider.id} className="flex items-start gap-2 py-2 border-b border-warm-border last:border-0">
                      <input
                        type="checkbox"
                        checked={provider.config.enabled}
                        onChange={async (e) => {
                          await invoke("set_enrichment_provider_config", {
                            providerId: provider.id,
                            enabled: e.target.checked,
                            apiKey: provider.config.apiKey,
                          }).catch(() => {});
                          loadProviders();
                        }}
                        className="mt-0.5 accent-accent"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-ink">{provider.name}</span>
                        {provider.apiKeyHelp && (
                          <div className="mt-1">
                            <input
                              type="text"
                              value={provider.config.apiKey ?? ""}
                              onChange={(e) => {
                                setEnrichmentProviders((prev) =>
                                  prev.map((p) =>
                                    p.id === provider.id
                                      ? { ...p, config: { ...p.config, apiKey: e.target.value } }
                                      : p
                                  )
                                );
                              }}
                              onBlur={async (e) => {
                                await invoke("set_enrichment_provider_config", {
                                  providerId: provider.id,
                                  enabled: provider.config.enabled,
                                  apiKey: e.target.value || null,
                                }).catch(() => {});
                              }}
                              placeholder="API key (optional)"
                              className="w-full text-xs bg-warm-subtle border border-warm-border rounded px-2 py-1 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
                            />
                            <p className="text-[10px] text-ink-muted mt-0.5">{provider.apiKeyHelp}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Accordion>

          <Accordion title="Activity">
            <button type="button" onClick={() => setShowActivityLog(true)}
              className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left">
              View activity log
            </button>
          </Accordion>

          {backupProviders.length > 0 && (
            <Accordion title="Remote Backup">
              <div className="space-y-2">
                {/* Provider selector */}
                <div className="bg-warm-subtle rounded-xl px-3 py-2.5">
                  <label className="text-xs text-ink-muted mb-1 block">Provider</label>
                  <select
                    value={selectedProvider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="w-full bg-transparent text-sm text-ink focus:outline-none cursor-pointer"
                  >
                    {backupProviders.map((p) => (
                      <option key={p.providerType} value={p.providerType}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Dynamic config fields */}
                {currentProviderInfo && currentProviderInfo.fields.map((field) => {
                  if (field.fieldType === "checkbox") {
                    return (
                      <label key={field.key} className="flex items-center gap-2.5 cursor-pointer px-1">
                        <input
                          type="checkbox"
                          checked={backupFieldValues[field.key] === "true"}
                          onChange={(e) =>
                            setBackupFieldValues((prev) => ({
                              ...prev,
                              [field.key]: e.target.checked ? "true" : "false",
                            }))
                          }
                          className="accent-accent"
                        />
                        <span className="text-sm text-ink">{field.label}</span>
                      </label>
                    );
                  }
                  return (
                    <div key={field.key} className="bg-warm-subtle rounded-xl px-3 py-2.5">
                      <label className="text-xs text-ink-muted mb-1 block">
                        {field.label}
                        {field.required && (
                          <span className="text-accent ml-1">*</span>
                        )}
                      </label>
                      <input
                        type={field.fieldType === "password" ? "password" : "text"}
                        value={backupFieldValues[field.key] ?? ""}
                        onChange={(e) =>
                          setBackupFieldValues((prev) => ({
                            ...prev,
                            [field.key]: e.target.value,
                          }))
                        }
                        placeholder={field.placeholder}
                        className="w-full bg-transparent text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none"
                      />
                    </div>
                  );
                })}

                {/* Save config */}
                <button
                  onClick={handleSaveBackupConfig}
                  disabled={savingBackupConfig || !selectedProvider}
                  className="w-full px-3 py-2 text-sm font-medium bg-accent text-surface rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {savingBackupConfig ? "Saving…" : "Save Configuration"}
                </button>

                {/* Backup now — only shown when a config has been saved */}
                {savedBackupConfig && (
                  <button
                    onClick={handleRunBackup}
                    disabled={runningBackup}
                    className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left disabled:opacity-40 flex items-center gap-2"
                  >
                    {runningBackup && (
                      <svg
                        className="animate-spin w-3.5 h-3.5 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle
                          className="opacity-25"
                          cx="12" cy="12" r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                        />
                      </svg>
                    )}
                    {runningBackup ? "Backing up…" : "Backup Now"}
                  </button>
                )}

                {/* Last backup timestamp */}
                {backupStatus && (
                  <p className="text-xs text-ink-muted px-1">
                    Last backup:{" "}
                    {new Date(backupStatus.lastSyncAt * 1000).toLocaleString()}
                    {" · "}
                    Device: {backupStatus.deviceId}
                  </p>
                )}

                {/* Status messages */}
                {remoteBackupMessage && (
                  <p className="text-xs text-ink-muted px-1">{remoteBackupMessage}</p>
                )}
              </div>
            </Accordion>
          )}
        </div>
      </div>

      {showActivityLog && <ActivityLog onClose={() => setShowActivityLog(false)} />}

      {/* Migration confirmation dialog */}
      {migrationDialog && (
        <>
          <div
            className="fixed inset-0 bg-ink/40 z-[60]"
            onClick={handleCancelMigration}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label="Change library folder"
            aria-modal="true"
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                Change Library Folder
              </h3>

              {/* Paths */}
              <div className="space-y-2 text-sm">
                <div>
                  <p className="text-xs text-ink-muted mb-0.5">Current folder</p>
                  <p className="text-ink font-mono text-xs break-all bg-warm-subtle rounded-lg px-2.5 py-1.5">
                    {migrationDialog.currentFolder}
                  </p>
                </div>
                <div className="flex justify-center text-ink-muted text-xs">↓</div>
                <div>
                  <p className="text-xs text-ink-muted mb-0.5">New folder</p>
                  <p className="text-ink font-mono text-xs break-all bg-warm-subtle rounded-lg px-2.5 py-1.5">
                    {migrationDialog.newFolder}
                  </p>
                </div>
              </div>

              {/* File count / size */}
              <p className="text-sm text-ink-muted">
                {migrationDialog.fileCount} {migrationDialog.fileCount === 1 ? "file" : "files"},{" "}
                {formatBytes(migrationDialog.totalSizeBytes)}
              </p>

              {/* Don't move checkbox */}
              <label className="flex items-start gap-2.5 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={dontMoveFiles}
                  onChange={(e) => setDontMoveFiles(e.target.checked)}
                  disabled={migrating}
                  className="mt-0.5 accent-accent"
                />
                <span className="text-sm text-ink leading-snug">
                  Don't move existing files — only use new folder for future imports
                </span>
              </label>

              {/* Error */}
              {migrationError && (
                <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                  {migrationError}
                </p>
              )}

              {/* Actions */}
              <div className="flex gap-2 justify-end">
                <button
                  onClick={handleCancelMigration}
                  disabled={migrating}
                  className="px-4 py-2 text-sm text-ink-muted hover:text-ink rounded-xl transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmMigration}
                  disabled={migrating}
                  className="px-4 py-2 text-sm font-medium bg-accent text-surface rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
                >
                  {migrating && (
                    <svg
                      className="animate-spin w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12" cy="12" r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                      />
                    </svg>
                  )}
                  {dontMoveFiles ? "Change Folder" : "Move & Update"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
