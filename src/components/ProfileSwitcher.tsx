import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { friendlyError } from "../lib/errors";

interface Profile {
  name: string;
  is_active: boolean;
}

interface ProfileSwitcherProps {
  onSwitch: () => void;
}

export default function ProfileSwitcher({ onSwitch }: ProfileSwitcherProps) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const loadProfiles = useCallback(async () => {
    try {
      const ps = await invoke<Profile[]>("get_profiles");
      setProfiles(ps);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setError(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const activeProfile = profiles.find((p) => p.is_active)?.name ?? "default";

  const handleSwitch = async (name: string) => {
    if (name === activeProfile) { setOpen(false); return; }
    try {
      await invoke("switch_profile", { name });
      await loadProfiles();
      setOpen(false);
      onSwitch();
    } catch (err) {
      setError(friendlyError(err, t));
    }
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await invoke("create_profile", { name: trimmed });
      await invoke("switch_profile", { name: trimmed });
      await loadProfiles();
      setNewName("");
      setCreating(false);
      setOpen(false);
      onSwitch();
    } catch (err) {
      setError(friendlyError(err, t));
    }
  };

  const handleDelete = async (name: string) => {
    setError(null);
    try {
      await invoke("delete_profile", { name });
      await loadProfiles();
    } catch (err) {
      setError(friendlyError(err, t));
    }
  };

  // Don't show switcher if only default profile
  if (profiles.length <= 1 && !open) {
    return (
      <button
        onClick={() => { loadProfiles(); setOpen(true); }}
        className="text-xs text-ink-muted hover:text-ink transition-colors ml-2"
        title={t("profiles.manageProfiles")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 21v-1a6 6 0 0112 0v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M20 11v4m-2-2h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    );
  }

  return (
    <div className="relative ml-2" ref={dropdownRef}>
      <button
        onClick={() => { setOpen(!open); if (!open) loadProfiles(); }}
        className="flex items-center gap-1.5 px-2 py-1 text-xs text-ink-muted hover:text-ink bg-warm-subtle hover:bg-warm-border rounded-lg transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 21v-1a6 6 0 0112 0v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {activeProfile}
        <svg width="10" height="10" viewBox="0 0 20 20" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M5 7l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-52 bg-surface border border-warm-border rounded-xl shadow-lg z-50 py-1 animate-fade-in">
          {profiles.map((p) => (
            <div
              key={p.name}
              className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                p.is_active ? "bg-accent-light text-accent" : "text-ink-muted hover:text-ink hover:bg-warm-subtle"
              }`}
              onClick={() => handleSwitch(p.name)}
            >
              <span className="flex-1 text-sm font-medium truncate">{p.name}</span>
              {p.is_active && (
                <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
              )}
              {!p.is_active && p.name !== "default" && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(p.name); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-muted hover:text-red-500 transition-all"
                  aria-label={t("profiles.deleteLabel", { name: p.name })}
                >
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                    <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          ))}

          <div className="mx-2 my-1 border-t border-warm-border" />

          {creating ? (
            <div className="px-3 py-2 space-y-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") { setCreating(false); setError(null); } }}
                placeholder={t("profiles.profileName")}
                autoFocus
                className="w-full text-sm bg-warm-subtle border border-warm-border rounded-lg px-2.5 py-1.5 text-ink placeholder-ink-muted/50 focus:outline-none focus:border-accent"
              />
              {error && <p className="text-[10px] text-red-500">{error}</p>}
              <div className="flex gap-1.5">
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim()}
                  className="flex-1 py-1 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40"
                >
                  {t("common.create")}
                </button>
                <button
                  onClick={() => { setCreating(false); setError(null); }}
                  className="flex-1 py-1 text-xs text-ink-muted hover:text-ink transition-colors"
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full px-3 py-2 text-xs text-ink-muted hover:text-accent hover:bg-warm-subtle transition-colors text-left flex items-center gap-1.5"
            >
              <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {t("profiles.newProfile")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
