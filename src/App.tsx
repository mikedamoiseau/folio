import { useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";
import { ThemeProvider } from "./context/ThemeContext";
import SettingsPanel from "./components/SettingsPanel";
import ReadingStats from "./components/ReadingStats";
import ProfileSwitcher from "./components/ProfileSwitcher";
import CatalogBrowser from "./components/CatalogBrowser";
import LanguageSwitcher from "./components/LanguageSwitcher";
import Library from "./screens/Library";
import Reader from "./screens/Reader";

function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [profileKey, setProfileKey] = useState(0);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const inReader = location.pathname.startsWith("/reader/");

  const handleProfileSwitch = useCallback(() => {
    navigate("/");
    setProfileKey((k) => k + 1); // force Library remount
  }, [navigate]);

  return (
    <div className="flex flex-col h-screen bg-paper text-ink">
      {/* Top nav — minimal wordmark header, hidden in reader (reader has its own header) */}
      {!inReader && (
        <nav className="shrink-0 h-12 px-6 flex items-center border-b border-warm-border bg-surface">
          <Link
            to="/"
            className="font-serif text-xl font-semibold tracking-tight text-ink hover:text-accent transition-colors duration-150"
          >
            Folio
          </Link>
          <ProfileSwitcher onSwitch={handleProfileSwitch} />
          <div className="flex-1" />
          <button
            onClick={() => setStatsOpen(true)}
            className="p-2 text-ink-muted hover:text-ink transition-colors duration-150 rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            aria-label="Reading stats"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M3 17V9h3v8H3zM8.5 17V5h3v12h-3zM14 17V1h3v16h-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => setCatalogOpen(true)}
            className="p-2 text-ink-muted hover:text-ink transition-colors duration-150 rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            aria-label="Browse catalogs"
            title="Browse book catalogs"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <LanguageSwitcher />
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 text-ink-muted hover:text-ink transition-colors duration-150 rounded-lg hover:bg-warm-subtle focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            aria-label="Open settings"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M16.2 12.3a1.3 1.3 0 00.26 1.43l.05.05a1.58 1.58 0 11-2.23 2.23l-.05-.05a1.3 1.3 0 00-1.43-.26 1.3 1.3 0 00-.79 1.19v.14a1.58 1.58 0 01-3.16 0v-.07a1.3 1.3 0 00-.85-1.19 1.3 1.3 0 00-1.43.26l-.05.05a1.58 1.58 0 11-2.23-2.23l.05-.05a1.3 1.3 0 00.26-1.43 1.3 1.3 0 00-1.19-.79h-.14a1.58 1.58 0 010-3.16h.07a1.3 1.3 0 001.19-.85 1.3 1.3 0 00-.26-1.43l-.05-.05a1.58 1.58 0 112.23-2.23l.05.05a1.3 1.3 0 001.43.26h.06a1.3 1.3 0 00.79-1.19v-.14a1.58 1.58 0 013.16 0v.07a1.3 1.3 0 00.79 1.19 1.3 1.3 0 001.43-.26l.05-.05a1.58 1.58 0 112.23 2.23l-.05.05a1.3 1.3 0 00-.26 1.43v.06a1.3 1.3 0 001.19.79h.14a1.58 1.58 0 010 3.16h-.07a1.3 1.3 0 00-1.19.79z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        </nav>
      )}

      <main
        key={inReader ? "reader" : "library"}
        className="flex-1 overflow-auto min-h-0"
        style={{ animation: "route-enter 0.25s ease both" }}
      >
        <Routes>
          <Route path="/" element={<Library key={profileKey} />} />
          <Route
            path="/reader/:bookId"
            element={
              <Reader
                onOpenSettings={() => setSettingsOpen(true)}
                settingsOpen={settingsOpen}
              />
            }
          />
        </Routes>
      </main>

      {statsOpen && <ReadingStats onClose={() => setStatsOpen(false)} />}
      {catalogOpen && (
        <CatalogBrowser
          onClose={() => setCatalogOpen(false)}
          onBookImported={() => setProfileKey((k) => k + 1)}
        />
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
