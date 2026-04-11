import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useTheme, MIN_FONT_SIZE, MAX_FONT_SIZE, type ColorTokens } from "../context/ThemeContext";
import { friendlyError } from "../lib/errors";
import {
  SEPIA_TOKENS,
  LIGHT_TOKENS,
  deriveTokensFromBase,
} from "../lib/themes";
import ActivityLog from "./ActivityLog";

function Accordion({ title, children, open, onToggle }: { title: string; children: ReactNode; open: boolean; onToggle: () => void }) {
  const sectionId = `section-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={sectionId}
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
          aria-hidden="true"
          className={`text-ink-muted/50 group-hover:text-ink-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div id={sectionId} role="region" aria-label={title} className="mt-3">{children}</div>}
    </section>
  );
}

// ── Custom color theme editor ───────────────────────────────

const TOKEN_GROUPS: Array<{
  labelKey: string;
  tokens: Array<{ key: keyof ColorTokens; labelKey: string }>;
}> = [
  {
    labelKey: "settings.accent",
    tokens: [
      { key: "accent", labelKey: "settings.accent" },
      { key: "accent-hover", labelKey: "settings.accentHover" },
      { key: "accent-light", labelKey: "settings.accentLight" },
    ],
  },
  {
    labelKey: "settings.surface",
    tokens: [
      { key: "surface", labelKey: "settings.cardLabel" },
      { key: "ink-muted", labelKey: "settings.mutedText" },
      { key: "warm-border", labelKey: "settings.border" },
      { key: "warm-subtle", labelKey: "settings.subtleFill" },
    ],
  },
];

function CustomColorEditor({
  customColors,
  setCustomColors,
}: {
  customColors: ColorTokens;
  setCustomColors: (c: ColorTokens) => void;
}) {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const updateColor = (key: keyof ColorTokens, value: string) => {
    setCustomColors({ ...customColors, [key]: value });
  };

  const updateBaseAndDerive = (key: "paper" | "ink", value: string) => {
    const paper = key === "paper" ? value : customColors.paper;
    const ink = key === "ink" ? value : customColors.ink;
    const derived = deriveTokensFromBase(paper, ink);
    setCustomColors(derived);
  };

  return (
    <div className="space-y-3 rounded-xl bg-warm-subtle p-3">
      {/* Primary pickers: Background + Text */}
      <div className="flex gap-3">
        <ColorInput
          label={t("settings.background")}
          value={customColors.paper}
          onChange={(v) => updateBaseAndDerive("paper", v)}
        />
        <ColorInput
          label={t("settings.text")}
          value={customColors.ink}
          onChange={(v) => updateBaseAndDerive("ink", v)}
        />
      </div>

      {/* Live preview */}
      <div
        className="rounded-lg px-3 py-2 text-sm leading-relaxed"
        style={{ backgroundColor: customColors.paper, color: customColors.ink }}
      >
        {t("settings.fontPreview")}
      </div>

      {/* Advanced toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-xs text-ink-muted hover:text-ink transition-colors"
      >
        {showAdvanced ? t("settings.hideAdvanced") : t("settings.showAdvanced")}
      </button>

      {/* Advanced token grid */}
      {showAdvanced && (
        <div className="space-y-3">
          {TOKEN_GROUPS.map((group) => (
            <div key={group.labelKey}>
              <p className="text-xs text-ink-muted mb-1.5">{t(group.labelKey)}</p>
              <div className="flex flex-wrap gap-2">
                {group.tokens.map(({ key, labelKey }) => (
                  <ColorInput
                    key={key}
                    label={t(labelKey)}
                    value={customColors[key]}
                    onChange={(v) => updateColor(key, v)}
                    compact
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preset shortcuts */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={() => setCustomColors({ ...SEPIA_TOKENS })}
          className="flex-1 px-2 py-1.5 text-xs rounded-lg border border-warm-border text-ink-muted hover:text-ink hover:border-ink-muted transition-colors"
        >
          {t("settings.resetToSepia")}
        </button>
        <button
          type="button"
          onClick={() => setCustomColors({ ...LIGHT_TOKENS })}
          className="flex-1 px-2 py-1.5 text-xs rounded-lg border border-warm-border text-ink-muted hover:text-ink hover:border-ink-muted transition-colors"
        >
          {t("settings.resetToLight")}
        </button>
      </div>
    </div>
  );
}

function ColorInput({
  label,
  value,
  onChange,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 ${compact ? "" : "flex-1"}`}>
      <div className="relative">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
        />
        <div
          className={`${compact ? "w-6 h-6" : "w-8 h-8"} rounded-lg border border-warm-border shadow-sm cursor-pointer`}
          style={{ backgroundColor: value }}
        />
      </div>
      <span className={`${compact ? "text-xs" : "text-sm"} text-ink-muted`}>
        {label}
      </span>
    </label>
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
  const { t } = useTranslation();
  const { mode, setMode, customColors, setCustomColors, fontSize, setFontSize, fontFamily, setFontFamily, scrollMode, setScrollMode, typography, setTypography, customCss, setCustomCss, dualPage, setDualPage, mangaMode, setMangaMode, pageAnimation, setPageAnimation } =
    useTheme();
  const [openSection, setOpenSection] = useState<string | null>("appearance");
  const toggleSection = (id: string) => setOpenSection((prev) => (prev === id ? null : id));
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
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [autoBackups, setAutoBackups] = useState<{ path: string; label: string; timestamp: number; sizeBytes: number }[]>([]);
  const [restoreConfirmPath, setRestoreConfirmPath] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [includeFiles, setIncludeFiles] = useState(false);
  const [cleanupState, setCleanupState] = useState<
    "idle" | "confirm" | "scanning" | "done"
  >("idle");
  const [cleanupProgress, setCleanupProgress] = useState({ current: 0, total: 0 });
  const [cleanupResult, setCleanupResult] = useState<{
    removedCount: number;
    backupPath: string;
  } | null>(null);

  // Import mode setting
  const [importMode, setImportMode] = useState<string>("import");

  // Page cache settings
  const [pageCacheLimit, setPageCacheLimit] = useState("500");
  const [cacheStats, setCacheStats] = useState<{ total_size_bytes: number; book_count: number } | null>(null);

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
  const [backupProgressText, setBackupProgressText] = useState("");
  const [backupStatus, setBackupStatus] = useState<SyncManifest | null>(null);
  const [remoteBackupMessage, setRemoteBackupMessage] = useState<string | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [lastSyncSuccess, setLastSyncSuccess] = useState<number | null>(null);
  const [lastSyncError, setLastSyncError] = useState<{ at: number; message: string } | null>(null);

  // Web server state
  const [webServerRunning, setWebServerRunning] = useState(false);
  const [webServerUrl, setWebServerUrl] = useState<string | null>(null);
  const [webServerPort, setWebServerPort] = useState("7788");
  const [webServerPin, setWebServerPin] = useState("");
  const [webServerQr, setWebServerQr] = useState<string | null>(null);
  const [webServerError, setWebServerError] = useState<string | null>(null);
  const [webServerLoading, setWebServerLoading] = useState(false);
  const [pinSaved, setPinSaved] = useState(false);

  // Custom fonts
  interface CustomFont {
    id: string;
    name: string;
    fileName: string;
    filePath: string;
    createdAt: number;
  }

  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [deletingFontId, setDeletingFontId] = useState<string | null>(null);

  const loadCustomFonts = useCallback(async () => {
    try {
      const fonts = await invoke<CustomFont[]>("get_custom_fonts");
      setCustomFonts(fonts);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    loadCustomFonts();
  }, [loadCustomFonts]);

  // Inject @font-face rules for custom fonts
  useEffect(() => {
    const styleId = "custom-fonts-style";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = customFonts
      .map(
        (f) =>
          `@font-face { font-family: "CustomFont-${f.id}"; src: url("https://asset.localhost/${f.filePath}"); font-display: swap; }`,
      )
      .join("\n");
  }, [customFonts]);

  const handleImportFont = async () => {
    try {
      const selected = await openFilePicker({
        multiple: false,
        filters: [
          { name: "Font Files", extensions: ["ttf", "otf", "woff2"] },
        ],
      });
      if (!selected) return;
      const filePath = typeof selected === "string" ? selected : selected[0];
      await invoke("import_custom_font", { filePath });
      await loadCustomFonts();
    } catch {
      // non-fatal
    }
  };

  const handleDeleteFont = async (fontId: string) => {
    try {
      if (fontFamily === `custom:${fontId}`) {
        setFontFamily("serif");
      }
      await invoke("remove_custom_font", { fontId });
      await loadCustomFonts();
    } catch {
      // non-fatal
    }
    setDeletingFontId(null);
  };

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

  const loadCacheInfo = useCallback(async () => {
    try {
      const limit = await invoke<string | null>("get_setting_value", { key: "page_cache_max_size_mb" });
      if (limit) setPageCacheLimit(limit);
      const stats = await invoke<{ total_size_bytes: number; book_count: number }>("get_cache_stats");
      setCacheStats(stats);
    } catch {
      // Cache stats unavailable
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

      const syncSetting = await invoke<string | null>("get_setting_value", { key: "sync_enabled" });
      setSyncEnabled(syncSetting === "true");

      const successAt = await invoke<string | null>("get_setting_value", { key: "last_sync_success_at" });
      setLastSyncSuccess(successAt ? parseInt(successAt, 10) : null);

      const errorAt = await invoke<string | null>("get_setting_value", { key: "last_sync_error_at" });
      const errorMsg = await invoke<string | null>("get_setting_value", { key: "last_sync_error_message" });
      if (errorAt) {
        setLastSyncError({ at: parseInt(errorAt, 10), message: errorMsg || "Unknown error" });
      } else {
        setLastSyncError(null);
      }
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
      loadCacheInfo();
      (async () => {
        const scanImport = await invoke<string | null>("get_setting_value", { key: "auto_scan_import" });
        setAutoScanImport(scanImport !== "false");
        const scanStartup = await invoke<string | null>("get_setting_value", { key: "auto_scan_startup" });
        setAutoScanStartup(scanStartup === "true");
        const importModeVal = await invoke<string | null>("get_setting_value", { key: "import_mode" });
        if (importModeVal) setImportMode(importModeVal);
        // Load web server status
        try {
          const status = await invoke<{ running: boolean; url: string | null; port: number; has_pin: boolean }>("web_server_status");
          setWebServerRunning(status.running);
          setWebServerUrl(status.url);
          setWebServerPort(String(status.port));
          if (status.running) {
            try { const qr = await invoke<string>("web_server_get_qr"); setWebServerQr(qr); } catch {}
          }
        } catch {}
      })().catch(() => {});
    }
  }, [open, loadLibraryFolder, loadBackupSettings, loadProviders, loadCacheInfo]);

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

  const handleCacheLimitChange = useCallback(async (value: string) => {
    setPageCacheLimit(value);
    try {
      await invoke("set_setting_value", { key: "page_cache_max_size_mb", value });
    } catch {
      // Setting save failed
    }
  }, []);

  const handleClearCache = useCallback(async () => {
    try {
      await invoke("clear_page_cache");
      setCacheStats({ total_size_bytes: 0, book_count: 0 });
    } catch {
      // Clear failed
    }
  }, []);

  const handleChangeFolder = async () => {
    try {
      const picked = await openFilePicker({ directory: true });
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
      setMigrationError(friendlyError(String(err), t));
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
      const dest = await openFilePicker({
        directory: true,
      });
      if (!dest) return;
      setExporting(true);
      setBackupMessage(null);
      const folder = typeof dest === "string" ? dest : dest[0];
      const path = `${folder}/folio-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      await invoke("export_library", { destPath: path, includeFiles });
      setBackupMessage(t("settings.exportedTo", { path }));
    } catch (err) {
      setBackupMessage(t("settings.exportFailed", { error: friendlyError(String(err), t) }));
    } finally {
      setExporting(false);
    }
  };

  const loadAutoBackups = async () => {
    try {
      const list = await invoke<{ path: string; label: string; timestamp: number; sizeBytes: number }[]>(
        "list_auto_backups"
      );
      setAutoBackups(list);
    } catch {
      setAutoBackups([]);
    }
  };

  const handleOpenRestoreModal = async () => {
    setRestoreModalOpen(true);
    setBackupMessage(null);
    await loadAutoBackups();
  };

  const handleRestoreFromFile = async () => {
    try {
      const selected = await openFilePicker({
        multiple: false,
        filters: [{ name: "Backup", extensions: ["zip"] }],
      } as Parameters<typeof openFilePicker>[0]);
      if (!selected) return;
      const path = typeof selected === "string" ? selected : selected[0];
      setRestoreConfirmPath(path);
    } catch {
      // User cancelled
    }
  };

  const handleConfirmRestore = async () => {
    if (!restoreConfirmPath) return;
    setRestoring(true);
    try {
      const count = await invoke<number>("import_library_backup", { archivePath: restoreConfirmPath });
      setBackupMessage(t("settings.importedBooks", { count }));
      setRestoreConfirmPath(null);
      setRestoreModalOpen(false);
    } catch (err) {
      setBackupMessage(t("settings.importFailed", { error: friendlyError(String(err), t) }));
      setRestoreConfirmPath(null);
    } finally {
      setRestoring(false);
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
      setRemoteBackupMessage(t("settings.configSaved"));
    } catch (err) {
      setRemoteBackupMessage(t("settings.saveFailed", { error: friendlyError(String(err), t) }));
    } finally {
      setSavingBackupConfig(false);
    }
  };

  const handleToggleSync = async (enabled: boolean) => {
    const prev = syncEnabled;
    setSyncEnabled(enabled);
    try {
      await invoke("set_setting_value", { key: "sync_enabled", value: enabled ? "true" : "false" });
    } catch {
      setSyncEnabled(prev);
    }
  };

  const handleRunBackup = async () => {
    setRunningBackup(true);
    setRemoteBackupMessage(null);
    setBackupProgressText(t("settings.starting"));
    const unlisten = await listen<{ step: string; current: number; total: number }>("backup-progress", (event) => {
      const { step, current, total } = event.payload;
      if (total > 0) {
        setBackupProgressText(`${step} ${current}/${total}`);
      } else {
        setBackupProgressText(step);
      }
    });
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
        parts.length > 0 ? t("settings.backedUp", { details: parts.join(", ") }) : t("settings.alreadyUpToDate");
      setRemoteBackupMessage(summary);
      const status = await invoke<SyncManifest | null>("get_backup_status");
      setBackupStatus(status);
    } catch (err) {
      setRemoteBackupMessage(t("settings.backupFailed", { error: friendlyError(String(err), t) }));
    } finally {
      unlisten();
      setRunningBackup(false);
      setBackupProgressText("");
    }
  };

  const handleCleanup = async () => {
    setCleanupState("scanning");
    setCleanupProgress({ current: 0, total: 0 });
    const unlisten = await listen<{ current: number; total: number }>(
      "cleanup-progress",
      (event) => {
        setCleanupProgress(event.payload);
      }
    );
    try {
      const result = await invoke<{ removedCount: number; removedBooks: { id: string; title: string; author: string }[]; backupPath: string }>(
        "cleanup_library"
      );
      setCleanupResult({ removedCount: result.removedCount, backupPath: result.backupPath });
      setCleanupState("done");
    } catch (err) {
      setCleanupResult(null);
      setCleanupState("idle");
    } finally {
      unlisten();
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-ink/20 backdrop-blur-sm z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby="settings-panel-title"
        aria-modal="true"
        tabIndex={-1}
        className="fixed right-0 top-0 bottom-0 w-80 max-w-[90vw] bg-surface border-l border-warm-border z-50 flex flex-col shadow-[-4px_0_24px_-4px_rgba(44,34,24,0.12)] outline-none animate-slide-in-right"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-warm-border flex items-center justify-between">
          <h2 id="settings-panel-title" className="font-serif text-base font-semibold text-ink">
            {t("settings.title")}
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-ink-muted hover:text-ink transition-colors rounded focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            aria-label={t("settings.closeLabel")}
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Settings content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-7">
          {/* Theme */}
          <Accordion title={t("settings.appearance")} open={openSection === "appearance"} onToggle={() => toggleSection("appearance")}>
            <div className="space-y-3">
              {/* Preset mode buttons */}
              <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
                {(["light", "sepia", "dark", "system"] as const).map((option) => (
                  <button
                    type="button"
                    key={option}
                    onClick={() => setMode(option)}
                    className={`flex-1 px-2 py-2 text-sm rounded-lg capitalize transition-all duration-150 ${
                      mode === option
                        ? "bg-surface text-ink shadow-sm font-medium"
                        : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {option === "system" ? t("settings.auto") : option === "light" ? t("settings.light") : option === "sepia" ? t("settings.sepia") : t("settings.dark")}
                  </button>
                ))}
              </div>

              {/* Custom theme toggle */}
              <button
                type="button"
                onClick={() => setMode(mode === "custom" ? "light" : "custom")}
                className={`w-full px-3 py-2 text-sm rounded-lg border transition-all duration-150 ${
                  mode === "custom"
                    ? "border-accent bg-accent-light text-ink font-medium"
                    : "border-warm-border text-ink-muted hover:text-ink hover:border-ink-muted"
                }`}
              >
                {t("settings.customColors")}
              </button>

              {/* Custom color editor */}
              {mode === "custom" && (
                <CustomColorEditor
                  customColors={customColors}
                  setCustomColors={setCustomColors}
                />
              )}
            </div>

            {/* Custom CSS */}
            <div className="mt-4 pt-4 border-t border-warm-border/50 space-y-2">
              <label className="text-xs font-medium text-ink-muted mb-1 block">{t("settings.customCss")}</label>
              <textarea
                value={customCss}
                onChange={(e) => setCustomCss(e.target.value)}
                placeholder={`.reader-content p {\n  color: #333;\n}`}
                className="w-full h-28 text-xs font-mono bg-warm-subtle border border-warm-border rounded-lg px-3 py-2 text-ink placeholder-ink-muted/40 focus:outline-none focus:border-accent resize-y"
                spellCheck={false}
              />
              <p className="text-[11px] text-ink-muted leading-relaxed" dangerouslySetInnerHTML={{ __html: t("settings.customCssHint") }} />
              {customCss && (
                <button
                  type="button"
                  onClick={() => setCustomCss("")}
                  className="text-xs text-ink-muted hover:text-ink transition-colors"
                >
                  {t("settings.clearCustomCss")}
                </button>
              )}
            </div>
          </Accordion>

          {/* Text & Typography */}
          <Accordion title={t("settings.textTypography")} open={openSection === "text"} onToggle={() => toggleSection("text")}>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setFontSize(fontSize - 1)}
                disabled={fontSize <= MIN_FONT_SIZE}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-warm-subtle text-ink-muted hover:text-ink hover:bg-warm-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                aria-label={t("reader.decreaseFontSize")}
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
                  aria-label={t("settings.fontSize")}
                  aria-valuetext={`${fontSize} pixels`}
                />
                <span className="text-xs text-ink-muted tabular-nums">
                  {fontSize}px
                </span>
              </div>
              <button
                onClick={() => setFontSize(fontSize + 1)}
                disabled={fontSize >= MAX_FONT_SIZE}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-warm-subtle text-ink-muted hover:text-ink hover:bg-warm-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                aria-label={t("reader.increaseFontSize")}
              >
                +
              </button>
            </div>

            {/* Reading font */}
            <div className="mt-4 pt-4 border-t border-warm-border/50">
            <label className="text-xs font-medium text-ink-muted mb-2 block">{t("settings.readingFont")}</label>
            <div className="flex flex-col gap-1">
              {/* Built-in fonts */}
              {([
                { key: "serif", label: "Lora", css: '"Lora Variable", Georgia, serif' },
                { key: "literata", label: "Literata", css: '"Literata Variable", Georgia, serif' },
                { key: "sans-serif", label: "DM Sans", css: '"DM Sans Variable", system-ui, sans-serif' },
                { key: "dyslexic", label: "OpenDyslexic", css: '"OpenDyslexic", sans-serif' },
              ] as const).map((option) => (
                <button
                  type="button"
                  key={option.key}
                  onClick={() => setFontFamily(option.key)}
                  className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-all duration-150 ${
                    fontFamily === option.key
                      ? "bg-accent-light text-accent font-medium"
                      : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
                  }`}
                  style={{ fontFamily: option.css }}
                >
                  {option.label}
                </button>
              ))}

              {/* Custom fonts */}
              {customFonts.map((font) => (
                <div
                  key={font.id}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-150 cursor-pointer ${
                    fontFamily === `custom:${font.id}`
                      ? "bg-accent-light text-accent font-medium"
                      : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
                  }`}
                  onClick={() => setFontFamily(`custom:${font.id}`)}
                >
                  <span
                    className="flex-1 text-sm truncate"
                    style={{ fontFamily: `"CustomFont-${font.id}", serif` }}
                  >
                    {font.name}
                  </span>
                  {deletingFontId === font.id ? (
                    <span className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteFont(font.id); }}
                        className="text-[10px] px-1.5 py-0.5 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
                      >
                        {t("common.delete")}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeletingFontId(null); }}
                        className="text-[10px] px-1.5 py-0.5 text-ink-muted hover:text-ink transition-colors"
                      >
                        {t("common.cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeletingFontId(font.id); }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-red-500 transition-all shrink-0"
                      aria-label={t("common.remove") + " " + font.name}
                    >
                      <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                        <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}

              {/* Add font button */}
              <button
                type="button"
                onClick={handleImportFont}
                className="w-full text-left px-3 py-2 text-sm text-accent hover:bg-warm-subtle rounded-lg transition-colors flex items-center gap-2"
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                  <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                {t("settings.addFont")}
              </button>
              <p className="px-3 text-[10px] text-ink-muted/60">
                {t("settings.addFontWarning")}
              </p>
            </div>

            {/* Font preview */}
            <p
              className="mt-3 text-sm text-ink-muted leading-relaxed"
              style={{
                fontFamily:
                  fontFamily === "serif"
                    ? '"Lora Variable", Georgia, serif'
                    : fontFamily === "literata"
                      ? '"Literata Variable", Georgia, serif'
                      : fontFamily === "dyslexic"
                        ? '"OpenDyslexic", sans-serif'
                        : fontFamily.startsWith("custom:")
                          ? `"CustomFont-${fontFamily.slice(7)}", serif`
                          : '"DM Sans Variable", system-ui, sans-serif',
              }}
            >
              {t("settings.fontPreview")}
            </p>
            </div>

            {/* Typography */}
            <div className="mt-4 pt-4 border-t border-warm-border/50">
            <div className="space-y-4">
              {/* Line height */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-ink-muted">{t("settings.lineHeight")}</label>
                  <span className="text-xs text-ink-muted tabular-nums">{typography.lineHeight.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min={1.2}
                  max={2.4}
                  step={0.1}
                  value={typography.lineHeight}
                  onChange={(e) => setTypography({ ...typography, lineHeight: parseFloat(e.target.value) })}
                  className="w-full accent-accent"
                />
              </div>

              {/* Page margins */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-ink-muted">{t("settings.pageMargins")}</label>
                  <span className="text-xs text-ink-muted tabular-nums">{typography.pageMargins}px</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={80}
                  step={4}
                  value={typography.pageMargins}
                  onChange={(e) => setTypography({ ...typography, pageMargins: parseInt(e.target.value, 10) })}
                  className="w-full accent-accent"
                />
              </div>

              {/* Paragraph spacing */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-ink-muted">{t("settings.paragraphSpacing")}</label>
                  <span className="text-xs text-ink-muted tabular-nums">{typography.paragraphSpacing.toFixed(1)}em</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={typography.paragraphSpacing}
                  onChange={(e) => setTypography({ ...typography, paragraphSpacing: parseFloat(e.target.value) })}
                  className="w-full accent-accent"
                />
              </div>

              {/* Text alignment */}
              <div>
                <label className="text-xs font-medium text-ink-muted mb-1 block">{t("settings.textAlignment")}</label>
                <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
                  {(["left", "justify"] as const).map((option) => (
                    <button
                      type="button"
                      key={option}
                      onClick={() => setTypography({ ...typography, textAlign: option })}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg capitalize transition-all duration-150 ${
                        typography.textAlign === option
                          ? "bg-surface text-ink shadow-sm font-medium"
                          : "text-ink-muted hover:text-ink"
                      }`}
                    >
                      {option === "left" ? t("settings.left") : t("settings.justify")}
                    </button>
                  ))}
                </div>
              </div>

              {/* Hyphenation */}
              <div>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-medium text-ink-muted">{t("settings.hyphenation")}</span>
                  <button
                    type="button"
                    onClick={() => setTypography({ ...typography, hyphenation: !typography.hyphenation })}
                    className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${typography.hyphenation ? "bg-accent" : "bg-warm-border"}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${typography.hyphenation ? "translate-x-4" : ""}`} />
                  </button>
                </label>
                <p className="text-[11px] text-ink-muted/60 mt-1">{t("settings.hyphenationHint")}</p>
              </div>
            </div>
            </div>
          </Accordion>

          {/* Page Layout */}
          <Accordion title={t("settings.pageLayout")} open={openSection === "layout"} onToggle={() => toggleSection("layout")}>
            <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
              {(["paginated", "continuous"] as const).map((option) => (
                <button
                  type="button"
                  key={option}
                  onClick={() => setScrollMode(option)}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg capitalize transition-all duration-150 ${
                    scrollMode === option
                      ? "bg-surface text-ink shadow-sm font-medium"
                      : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {option === "paginated" ? t("settings.paginated") : t("settings.continuous")}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              {scrollMode === "continuous"
                ? t("reader.continuousDescription")
                : t("reader.paginatedDescription")}
            </p>

            {/* Dual-page spread */}
            <div className="mt-4 pt-4 border-t border-warm-border/50 space-y-4">
              <label className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm text-ink">{t("settings.dualPageSpread")}</span>
                  <p className="text-[11px] text-ink-muted/60 mt-0.5">{t("settings.dualPageHint")}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={dualPage}
                  onClick={() => setDualPage(!dualPage)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${dualPage ? "bg-accent" : "bg-warm-border"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${dualPage ? "translate-x-4" : ""}`}
                  />
                </button>
              </label>

              {/* Manga mode toggle */}
              <label className={`flex items-center justify-between gap-3 ${!dualPage ? "opacity-40 pointer-events-none" : ""}`}>
                <div>
                  <span className="text-sm text-ink">{t("settings.mangaMode")}</span>
                  <p className="text-[11px] text-ink-muted/60 mt-0.5">{t("settings.mangaHint")}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={mangaMode}
                  aria-disabled={!dualPage}
                  onClick={() => dualPage && setMangaMode(!mangaMode)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${mangaMode && dualPage ? "bg-accent" : "bg-warm-border"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${mangaMode && dualPage ? "translate-x-4" : ""}`}
                  />
                </button>
              </label>
              {/* Page turn animation toggle */}
              <label className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm text-ink">{t("settings.pageAnimation")}</span>
                  <p className="text-[11px] text-ink-muted/60 mt-0.5">{t("settings.pageAnimationHint")}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={pageAnimation}
                  onClick={() => setPageAnimation(!pageAnimation)}
                  className={`relative w-10 h-6 rounded-full transition-colors ${pageAnimation ? "bg-accent" : "bg-warm-border"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${pageAnimation ? "translate-x-4" : ""}`}
                  />
                </button>
              </label>
            </div>
          </Accordion>

          {/* Library */}
          <Accordion title={t("settings.librarySection")} open={openSection === "library"} onToggle={() => toggleSection("library")}>
            <div className="space-y-2">
              <div className="bg-warm-subtle rounded-xl px-3 py-2.5">
                <p className="text-xs text-ink-muted mb-0.5">{t("settings.storageFolder")}</p>
                <p className="text-sm text-ink break-all leading-snug font-mono">
                  {libraryFolder ?? "—"}
                </p>
                {libraryInfo && (
                  <p className="text-xs text-ink-muted mt-1.5">
                    {libraryInfo.file_count === 1 ? t("settings.bookCount", { count: libraryInfo.file_count }) : t("settings.booksCount", { count: libraryInfo.file_count })} · {formatBytes(libraryInfo.total_size_bytes)}
                  </p>
                )}
              </div>
              <button
                onClick={handleChangeFolder}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
              >
                {t("settings.changeFolder")}
              </button>
              <button
                onClick={() => setCleanupState("confirm")}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
              >
                {t("settings.checkMissingFiles")}
              </button>

              <div className="mt-3 pt-3 border-t border-warm-border/50">
                <label className="text-xs font-medium text-ink-muted mb-2 block">{t("settings.importMode")}</label>
                <div className="flex gap-1 bg-warm-subtle rounded-xl p-1">
                  {(["import", "link"] as const).map((option) => (
                    <button
                      type="button"
                      key={option}
                      onClick={async () => {
                        setImportMode(option);
                        await invoke("set_setting_value", { key: "import_mode", value: option });
                      }}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg transition-all duration-150 ${
                        importMode === option
                          ? "bg-surface text-ink shadow-sm font-medium"
                          : "text-ink-muted hover:text-ink"
                      }`}
                    >
                      {option === "import" ? t("settings.importModeCopy") : t("settings.importModeLink")}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-ink-muted">{t("settings.importModeHelp")}</p>
              </div>

              {/* Page Cache */}
              <div className="mt-3 pt-3 border-t border-warm-border/50">
                <label className="text-xs font-medium text-ink-muted mb-2 block">{t("settings.pageCacheSection")}</label>

                <label className="block text-xs text-ink-muted mb-1">
                  {t("settings.pageCacheLimit")}
                </label>
                <select
                  value={pageCacheLimit}
                  onChange={(e) => handleCacheLimitChange(e.target.value)}
                  className="w-full rounded-xl border border-warm-border bg-warm-subtle px-3 py-2 text-sm text-ink"
                >
                  <option value="250">250 MB</option>
                  <option value="500">500 MB</option>
                  <option value="1024">1 GB</option>
                  <option value="2048">2 GB</option>
                </select>
                <p className="mt-1 text-xs text-ink-muted">{t("settings.pageCacheLimitHelp")}</p>

                <div className="mt-2 text-sm text-ink-muted">
                  {cacheStats && cacheStats.book_count > 0
                    ? t("settings.pageCacheUsage", {
                        size: formatBytes(cacheStats.total_size_bytes),
                        count: cacheStats.book_count,
                      })
                    : t("settings.pageCacheUsageEmpty")}
                </div>

                {cacheStats && cacheStats.book_count > 0 && (
                  <button
                    onClick={handleClearCache}
                    className="w-full mt-2 px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
                  >
                    {t("settings.clearPageCache")}
                  </button>
                )}
              </div>
            </div>
          </Accordion>

          {/* Backup & Restore */}
          <Accordion title={t("settings.backupRestore")} open={openSection === "backup"} onToggle={() => toggleSection("backup")}>
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
                  {t("settings.includeBookFiles")}
                  <span className="block text-xs text-ink-muted mt-0.5">
                    {includeFiles
                      ? t("settings.fullBackup")
                      : t("settings.metadataOnly")}
                  </span>
                </span>
              </label>
              <button
                onClick={handleExport}
                disabled={exporting}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left disabled:opacity-40"
              >
                {exporting ? t("common.working") : t("settings.exportLibrary")}
              </button>
              <button
                onClick={handleOpenRestoreModal}
                disabled={exporting}
                className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left disabled:opacity-40"
              >
                {t("settings.restoreFromBackup")}
              </button>
              {backupMessage && (
                <p className="text-xs text-ink-muted px-1">{backupMessage}</p>
              )}
            </div>
          </Accordion>

          {/* Metadata Scan */}
          <Accordion title={t("settings.metadataScan")} open={openSection === "scan"} onToggle={() => toggleSection("scan")}>
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
                  {t("settings.autoScanImport")}
                  <span className="block text-xs text-ink-muted mt-0.5">{t("settings.autoScanImportHint")}</span>
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
                  {t("settings.autoScanStartup")}
                  <span className="block text-xs text-ink-muted mt-0.5">{t("settings.autoScanStartupHint")}</span>
                </span>
              </label>
              {enrichmentProviders.length > 0 && (
                <div className="mt-3">
                  <h4 className="text-xs font-medium text-ink-muted mb-1">{t("settings.enrichmentSources")}</h4>
                  <p className="text-[10px] text-ink-muted mb-2">{t("settings.enrichmentSourcesOrder")}</p>
                  {enrichmentProviders.map((provider, index) => (
                    <div key={provider.id} className="flex items-start gap-2 py-2 border-b border-warm-border last:border-0">
                      <div className="flex flex-col items-center gap-0.5 mt-0.5">
                        <button
                          onClick={async () => {
                            if (index === 0) return;
                            const reordered = [...enrichmentProviders];
                            [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
                            setEnrichmentProviders(reordered);
                            await invoke("set_enrichment_provider_order", {
                              order: reordered.map((p) => p.id),
                            }).catch(() => {});
                          }}
                          disabled={index === 0}
                          className="text-[10px] leading-none text-ink-muted hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label={`Move ${provider.name} up`}
                        >
                          ▲
                        </button>
                        <button
                          onClick={async () => {
                            if (index === enrichmentProviders.length - 1) return;
                            const reordered = [...enrichmentProviders];
                            [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
                            setEnrichmentProviders(reordered);
                            await invoke("set_enrichment_provider_order", {
                              order: reordered.map((p) => p.id),
                            }).catch(() => {});
                          }}
                          disabled={index === enrichmentProviders.length - 1}
                          className="text-[10px] leading-none text-ink-muted hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label={`Move ${provider.name} down`}
                        >
                          ▼
                        </button>
                      </div>
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
                              placeholder={t("settings.apiKeyPlaceholder")}
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

          <Accordion title={t("settings.activity")} open={openSection === "activity"} onToggle={() => toggleSection("activity")}>
            <button type="button" onClick={() => setShowActivityLog(true)}
              className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left">
              {t("settings.viewActivityLog")}
            </button>
          </Accordion>

          <Accordion title={t("settings.remoteAccess")} open={openSection === "webserver"} onToggle={() => toggleSection("webserver")}>
            <div className="space-y-2">
              {/* PIN input (R4-2: save feedback, R4-1: guard) */}
              <div className="bg-warm-subtle rounded-xl px-3 py-2.5">
                <label htmlFor="web-server-pin" className="text-xs text-ink-muted mb-1 block">{t("settings.pin")}</label>
                <input
                  id="web-server-pin"
                  type="password"
                  value={webServerPin}
                  onChange={(e) => { setWebServerPin(e.target.value); setPinSaved(false); }}
                  placeholder={t("settings.pinPlaceholder")}
                  maxLength={8}
                  className="w-full bg-transparent text-sm text-ink focus:outline-none"
                />
                <div className="flex items-center gap-2 mt-1">
                  {webServerPin && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await invoke("web_server_set_pin", { pin: webServerPin });
                          setWebServerError(null);
                          setPinSaved(true);
                          setTimeout(() => setPinSaved(false), 2000);
                        } catch (e) { setWebServerError(friendlyError(String(e), t)); }
                      }}
                      className="text-xs text-accent hover:underline"
                    >
                      {t("settings.savePin")}
                    </button>
                  )}
                  {pinSaved && <span className="text-xs text-green-400">{t("settings.pinSaved")}</span>}
                </div>
              </div>

              {/* Port input */}
              <div className="bg-warm-subtle rounded-xl px-3 py-2.5">
                <label htmlFor="web-server-port" className="text-xs text-ink-muted mb-1 block">{t("settings.port")}</label>
                <input
                  type="number"
                  value={webServerPort}
                  onChange={(e) => setWebServerPort(e.target.value)}
                  className="w-full bg-transparent text-sm text-ink focus:outline-none"
                  id="web-server-port"
                  min={1024}
                  max={65535}
                  disabled={webServerRunning}
                />
              </div>

              {/* R1-4: Loading state + R4-1: PIN guard */}
              <button
                type="button"
                disabled={webServerLoading}
                onClick={async () => {
                  setWebServerError(null);
                  setWebServerLoading(true);
                  try {
                    if (webServerRunning) {
                      await invoke("web_server_stop");
                      setWebServerRunning(false);
                      setWebServerUrl(null);
                      setWebServerQr(null);
                    } else {
                      const url = await invoke<string>("web_server_start", { port: parseInt(webServerPort) || 7788 });
                      setWebServerRunning(true);
                      setWebServerUrl(url);
                      try { const qr = await invoke<string>("web_server_get_qr"); setWebServerQr(qr); } catch {}
                    }
                  } catch (e) { setWebServerError(friendlyError(String(e), t)); }
                  setWebServerLoading(false);
                }}
                className={`w-full px-3 py-2 text-sm font-medium rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  webServerRunning
                    ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                    : "bg-accent/20 text-accent hover:bg-accent/30"
                }`}
              >
                {webServerLoading
                  ? (webServerRunning ? t("settings.stopping") : t("settings.starting"))
                  : (webServerRunning ? t("settings.stopServer") : t("settings.startServer"))}
              </button>
              {/* Status + R1-5: Copy URL */}
              {webServerRunning && webServerUrl && (
                <div className="bg-warm-subtle rounded-xl px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-ink-muted flex-1">
                      {t("settings.serverRunningAt")}{" "}
                      <a href={webServerUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                        {webServerUrl}
                      </a>
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(webServerUrl);
                      }}
                      className="text-xs text-accent hover:underline shrink-0"
                    >
                      {t("settings.copyUrl")}
                    </button>
                  </div>
                  {webServerQr && (
                    <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: webServerQr }} />
                  )}
                </div>
              )}

              {webServerError && (
                <p className="text-xs text-red-500 px-1">{webServerError}</p>
              )}
            </div>
          </Accordion>

          {backupProviders.length > 0 && (
            <Accordion title={t("settings.remoteBackup")} open={openSection === "remote"} onToggle={() => toggleSection("remote")}>
              <div className="space-y-2">
                {/* Provider selector */}
                <div className="bg-warm-subtle rounded-xl px-3 py-2.5">
                  <label className="text-xs text-ink-muted mb-1 block">{t("settings.provider")}</label>
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
                  {savingBackupConfig ? t("common.saving") : t("settings.saveConfiguration")}
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
                    {runningBackup ? (backupProgressText || t("settings.backingUp")) : t("settings.backupNow")}
                  </button>
                )}

                {/* Last backup timestamp */}
                {backupStatus && (
                  <p className="text-xs text-ink-muted px-1">
                    {t("settings.lastBackup")}{" "}
                    {new Date(backupStatus.lastSyncAt * 1000).toLocaleString()}
                    {" · "}
                    {t("settings.device")} {backupStatus.deviceId}
                  </p>
                )}

                {/* Status messages */}
                {remoteBackupMessage && (
                  <p className="text-xs text-ink-muted px-1">{remoteBackupMessage}</p>
                )}

                {/* Sync toggle */}
                <div className="bg-warm-subtle rounded-xl px-3 py-2.5 mt-2">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-sm font-medium text-ink">Sync reading progress across devices</span>
                      <p className="text-xs text-ink-muted mt-0.5">
                        {savedBackupConfig
                          ? "Syncs reading progress, bookmarks, and highlights across devices using your configured remote backup destination. Does not sync book files."
                          : "Configure a remote backup destination to enable sync."}
                      </p>
                    </div>
                    <input
                      id="sync-toggle"
                      type="checkbox"
                      checked={syncEnabled}
                      disabled={!savedBackupConfig}
                      onChange={(e) => handleToggleSync(e.target.checked)}
                      className="ml-3 h-4 w-4 rounded accent-accent"
                      aria-label={!savedBackupConfig ? "Sync disabled: configure a remote backup destination first" : "Sync reading progress across devices"}
                    />
                  </label>

                  {syncEnabled && savedBackupConfig && (
                    <div className="mt-2 text-xs text-ink-muted space-y-0.5">
                      {lastSyncSuccess ? (
                        <p>Last successful sync: {new Date(lastSyncSuccess * 1000).toLocaleString()}</p>
                      ) : (
                        <p>Sync will run automatically when you open a book</p>
                      )}
                      {lastSyncError && (!lastSyncSuccess || lastSyncError.at > lastSyncSuccess) && (
                        <p className="text-red-500">Last sync error: {lastSyncError.message}</p>
                      )}
                    </div>
                  )}
                </div>
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
            className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[60]"
            onClick={handleCancelMigration}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label={t("settings.changeLibraryFolder")}
            aria-modal="true"
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                {t("settings.changeLibraryFolder")}
              </h3>

              {/* Paths */}
              <div className="space-y-2 text-sm">
                <div>
                  <p className="text-xs text-ink-muted mb-0.5">{t("settings.currentFolder")}</p>
                  <p className="text-ink font-mono text-xs break-all bg-warm-subtle rounded-lg px-2.5 py-1.5">
                    {migrationDialog.currentFolder}
                  </p>
                </div>
                <div className="flex justify-center text-ink-muted text-xs">↓</div>
                <div>
                  <p className="text-xs text-ink-muted mb-0.5">{t("settings.newFolder")}</p>
                  <p className="text-ink font-mono text-xs break-all bg-warm-subtle rounded-lg px-2.5 py-1.5">
                    {migrationDialog.newFolder}
                  </p>
                </div>
              </div>

              {/* File count / size */}
              <p className="text-sm text-ink-muted">
                {migrationDialog.fileCount === 1 ? t("settings.fileCount", { count: migrationDialog.fileCount }) : t("settings.filesCount", { count: migrationDialog.fileCount })},{" "}
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
                  {t("settings.dontMoveFiles")}
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
                  {t("common.cancel")}
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
                  {dontMoveFiles ? t("settings.changeFolder2") : t("settings.moveAndUpdate")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      {cleanupState !== "idle" && (
        <>
          <div
            className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[60]"
            onClick={() => cleanupState !== "scanning" && setCleanupState("idle")}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label={t("settings.cleanupConfirmTitle")}
            aria-modal="true"
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                {t("settings.cleanupConfirmTitle")}
              </h3>

              {cleanupState === "confirm" && (
                <>
                  <p className="text-sm text-ink-muted">
                    {t("settings.cleanupConfirmMessage")}
                  </p>
                  <div className="flex gap-3 justify-end pt-1">
                    <button
                      onClick={() => setCleanupState("idle")}
                      className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      onClick={handleCleanup}
                      className="px-4 py-2 text-sm bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors font-medium"
                    >
                      {t("settings.cleanupConfirmContinue")}
                    </button>
                  </div>
                </>
              )}

              {cleanupState === "scanning" && (
                <p className="text-sm text-ink-muted">
                  {t("settings.cleanupScanning", {
                    current: cleanupProgress.current,
                    total: cleanupProgress.total,
                  })}
                </p>
              )}

              {cleanupState === "done" && (
                <>
                  <p className="text-sm text-ink-muted">
                    {cleanupResult && cleanupResult.removedCount > 0
                      ? t("settings.cleanupDoneRemoved", { count: cleanupResult.removedCount })
                      : t("settings.cleanupDoneNone")}
                  </p>
                  {cleanupResult && (
                    <p className="text-xs text-ink-muted/70 break-all font-mono">
                      {t("settings.cleanupBackupSaved", { path: cleanupResult.backupPath })}
                    </p>
                  )}
                  <div className="flex justify-end pt-1">
                    <button
                      onClick={() => {
                        setCleanupState("idle");
                        loadLibraryFolder();
                      }}
                      className="px-4 py-2 text-sm bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors font-medium"
                    >
                      {t("settings.cleanupDone")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
      {restoreModalOpen && !restoreConfirmPath && (
        <>
          <div
            className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[60]"
            onClick={() => !restoring && setRestoreModalOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label={t("settings.restoreTitle")}
            aria-modal="true"
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                {t("settings.restoreTitle")}
              </h3>

              <div>
                <p className="text-xs font-medium text-ink-muted mb-2">{t("settings.autoBackups")}</p>
                {autoBackups.length === 0 ? (
                  <p className="text-sm text-ink-muted/70 italic">{t("settings.noAutoBackups")}</p>
                ) : (
                  <div className="max-h-[200px] overflow-y-auto space-y-1.5">
                    {autoBackups.map((backup) => (
                      <div
                        key={backup.path}
                        className="flex items-center justify-between gap-2 bg-warm-subtle rounded-xl px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-ink truncate">
                            {backup.label} — {new Intl.DateTimeFormat(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(backup.timestamp * 1000))}
                          </p>
                          <p className="text-xs text-ink-muted">{formatBytes(backup.sizeBytes)}</p>
                        </div>
                        <button
                          onClick={() => setRestoreConfirmPath(backup.path)}
                          className="shrink-0 px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors font-medium"
                        >
                          {t("settings.restore")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-medium text-ink-muted mb-2">{t("settings.fromFile")}</p>
                <button
                  onClick={handleRestoreFromFile}
                  className="w-full px-3 py-2 text-sm text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-xl transition-colors text-left"
                >
                  {t("settings.chooseFile")}
                </button>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  onClick={() => setRestoreModalOpen(false)}
                  className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {restoreConfirmPath && (
        <>
          <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-[80]" aria-hidden="true" />
          <div
            role="dialog"
            aria-label={t("settings.restoreTitle")}
            aria-modal="true"
            className="fixed inset-0 z-[90] flex items-center justify-center p-4"
          >
            <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-md border border-warm-border p-6 space-y-5">
              <h3 className="font-serif text-base font-semibold text-ink">
                {t("settings.restoreTitle")}
              </h3>
              <p className="text-sm text-ink-muted">
                {t("settings.restoreConfirmMessage")}
              </p>
              <div className="flex gap-3 justify-end pt-1">
                <button
                  onClick={() => setRestoreConfirmPath(null)}
                  disabled={restoring}
                  className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={handleConfirmRestore}
                  disabled={restoring}
                  className="px-4 py-2 text-sm bg-accent text-white rounded-xl hover:bg-accent-hover transition-colors font-medium disabled:opacity-40"
                >
                  {restoring ? t("common.working") : t("settings.restore")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
