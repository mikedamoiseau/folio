(function() {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const app = () => $("#app");

  // R3-4: Use httpOnly cookies only — no localStorage token storage
  let authenticated = false;

  // Item 7: URL (location.hash) is the source of truth for library state —
  // these are a parse cache of the current hash, refreshed by route() on
  // every navigation (see parseLibraryParams/showLibrary). Code that wants to
  // change the filter/search/sort must build a new hash (libraryHash()) and
  // navigate()/history.replaceState to it; never mutate these directly and
  // expect the view to follow.
  const DEFAULT_SORT = "date_added";
  let activeCollectionId = null;
  let activeSeries = null;
  let activeQuery = "";
  let activeSort = DEFAULT_SORT;

  // Item 6: theme mode is "light" | "dark" | "system", persisted to
  // localStorage. "system" means no data-theme attribute is set at all —
  // the CSS `@media (prefers-color-scheme: dark)` block then governs the
  // palette and updates live on its own when the OS preference changes, no
  // JS re-render needed. The index.html bootstrap script applies the same
  // stored value before first paint to avoid a flash of the wrong theme.
  const THEME_STORAGE_KEY = "folio_theme";
  let themeMode = localStorage.getItem(THEME_STORAGE_KEY) || "system";

  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function applyTheme() {
    if (themeMode === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", themeMode);
    }
  }

  function themeAriaLabel() {
    if (themeMode === "system") return `Theme: system (${systemPrefersDark() ? "dark" : "light"})`;
    return `Theme: ${themeMode}`;
  }

  function updateThemeButtonLabel() {
    const btn = $("#theme-toggle-btn");
    if (!btn) return;
    const label = themeAriaLabel();
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  // Applied immediately (idempotent with the index.html bootstrap script,
  // which already set data-theme for an explicit light/dark choice before
  // first paint) so "system" mode is also correctly reflected even if the
  // bootstrap script ever gets out of sync.
  applyTheme();

  // Item 6: "system" mode has no data-theme attribute at all, so the CSS
  // `@media (prefers-color-scheme: dark)` block already swaps the palette
  // live with no JS involvement. This listener only keeps the toggle
  // button's aria-label/title (which names the resolved scheme while in
  // system mode) in sync with that live change.
  if (window.matchMedia) {
    const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onSchemeChange = () => { if (themeMode === "system") updateThemeButtonLabel(); };
    if (schemeQuery.addEventListener) schemeQuery.addEventListener("change", onSchemeChange);
    else if (schemeQuery.addListener) schemeQuery.addListener(onSchemeChange); // Safari <14
  }

  // Item 5: bumped on every loadBooks() call; a response is only rendered if
  // it still matches the counter captured at call time — guards against a
  // slow request (now with more awaits, thanks to the shelf fetches)
  // clobbering a faster, later one (e.g. rapid search typing / filter
  // clicks).
  let libraryRenderGen = 0;

  // R2-3/R3-1: current view + reader state, used by the global keyboard
  // shortcut dispatcher and by the reader's own nav handlers.
  let currentView = null; // "login" | "library" | "detail" | "reader" | "stats" | "collections"
  let readerState = null; // set while currentView === "reader"; see showReader()
  let shortcutsOverlayOpen = false;

  // F10: true while the "You left off at..." resume prompt is on screen.
  // currentView is "reader" at that point but readerState is still null (the
  // book hasn't been entered yet), so the normal reader keyboard branch can't
  // handle Enter/Esc/Backspace — this flag lets the dispatcher special-case it.
  let resumePromptActive = false;
  let resumePromptBookId = null;

  // Item 4: set by the detail page's Continue/Start Over buttons just before
  // navigating to the reader, so showReader() can skip its own resume prompt
  // — the user already made that choice on the detail page. Consumed once.
  // scrollPosition carries the saved in-chapter offset for "continue" so the
  // reader can restore it (F2b) — read AND cleared at the very top of
  // showReader (F7) so an early return can never leak it.
  let readerEntryIntent = null; // { id, action: "continue" | "restart", scrollPosition } | null

  // F8: last progress this tab knows about per book, updated optimistically
  // on every reader navigation/scroll and confirmed on every successful PUT.
  // showDetail() prefers this over a GET that may have raced an in-flight
  // save. F9: lastSentIndex is this session's high-water mark per book — a
  // save carrying a lower index is dropped as out-of-order, except an
  // explicit "Start Over" (which resets the mark and legitimately writes 0).
  let lastKnownProgress = {}; // bookId -> { chapterIndex, scrollPosition, ts }
  let lastSentIndex = {};     // bookId -> last chapter_index confirmed sent this session
  let saveChains = {};        // bookId -> promise tail; serializes PUTs per book (F9)

  async function api(path) {
    const resp = await fetch(path, { credentials: "same-origin" });
    if (resp.status === 401) { authenticated = false; showLogin(); return null; }
    return resp;
  }

  // ── Router ────────────────────────────────────
  function navigate(hash) {
    window.location.hash = hash;
  }

  // Item 7: parse `#/library?q=...&series=...&collection=...&sort=...` (also
  // used for the bare `#`/`#/` home route, which parses to all defaults).
  function parseLibraryParams(hash) {
    const qIndex = hash.indexOf("?");
    const params = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : "");
    return {
      q: params.get("q") || "",
      series: params.get("series") || null,
      collection: params.get("collection") || null,
      sort: params.get("sort") || DEFAULT_SORT,
    };
  }

  // Item 7: the inverse of parseLibraryParams — the single place that turns
  // a desired library state into a hash string. Collapses to the bare "#"
  // home route when every param is at its default, so "no filters" always
  // has one canonical URL (goHome() and "All Books" both rely on this).
  function libraryHash(state) {
    const params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.series) params.set("series", state.series);
    if (state.collection) params.set("collection", state.collection);
    if (state.sort && state.sort !== DEFAULT_SORT) params.set("sort", state.sort);
    const qs = params.toString();
    return qs ? "#/library?" + qs : "#";
  }

  // Finding C: every explicit "go back to the home screen" action (header
  // back buttons, Esc/Backspace from detail) must clear any active
  // collection/series filter — otherwise a filter set on a previous library
  // visit silently survives into an unrelated round trip through
  // detail/stats/collections, landing back on a filtered grid with the
  // shelves suppressed. This is deliberately distinct from navigations that
  // set a filter on purpose right before going home (showDetail's series
  // link, showCollections' collection/series rows) — those must keep working
  // and do NOT go through this helper.
  function goHome() {
    navigate("#");
  }

  function route() {
    // K4: the shortcuts overlay is appended to document.body and must not
    // survive a navigation — it would block the next view and swallow
    // shortcuts on it.
    closeShortcutsOverlay();
    const hash = window.location.hash || "#";
    if (hash === "#" || hash === "#/" || hash.startsWith("#/library")) {
      return showLibrary(parseLibraryParams(hash));
    }
    if (hash === "#/stats") return showStats();
    if (hash === "#/collections") return showCollections();
    if (hash.startsWith("#/book/") && hash.includes("/read")) {
      const parts = hash.replace("#/book/", "").replace("/read", "").split("/");
      return showReader(parts[0], parseInt(parts[1] || "0"));
    }
    if (hash.startsWith("#/book/")) return showDetail(hash.replace("#/book/", ""));
    showLibrary(parseLibraryParams(hash));
  }

  window.addEventListener("hashchange", route);

  // ── Keyboard Shortcuts ────────────────────────
  // Single listener, dispatches on `currentView`. See docs/web-ui-improvements.md
  // Item 2 for the key map.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    // K2: the range slider is an <input> but isn't a "typing" surface — treat
    // it separately so shortcuts like Escape/Backspace/f still work after
    // interacting with it (native Arrow/Home/End stepping is handled before
    // this check runs; see the keydown listener below).
    if (tag === "INPUT" && el.type === "range") return false;
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
  }

  function isRangeInput(el) {
    return !!el && el.tagName === "INPUT" && el.type === "range";
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  function openShortcutsOverlay() {
    if (shortcutsOverlayOpen) return;
    shortcutsOverlayOpen = true;
    const div = document.createElement("div");
    div.className = "shortcuts-overlay";
    div.id = "shortcuts-overlay";
    div.innerHTML = `
      <div class="shortcuts-panel">
        <h2>Keyboard Shortcuts</h2>
        <dl>
          <dt>&larr; / &rarr;</dt><dd>Prev / next page or chapter</dd>
          <dt>Home / End</dt><dd>First / last page or chapter</dd>
          <dt>f</dt><dd>Toggle fullscreen</dd>
          <dt>Esc / Backspace</dt><dd>Back</dd>
          <dt>/</dt><dd>Focus search</dd>
          <dt>?</dt><dd>Show this overlay</dd>
        </dl>
        <button id="shortcuts-close">Close</button>
      </div>`;
    document.body.appendChild(div);
    $("#shortcuts-close").addEventListener("click", closeShortcutsOverlay);
    div.addEventListener("click", (e) => { if (e.target === div) closeShortcutsOverlay(); });
  }

  function closeShortcutsOverlay() {
    shortcutsOverlayOpen = false;
    const div = $("#shortcuts-overlay");
    if (div) div.remove();
  }

  document.addEventListener("keydown", (e) => {
    // K3: never hijack modified shortcuts (Cmd/Ctrl+F find, Cmd+ArrowLeft
    // history back, etc.) — bail before any preventDefault.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "?" && !isTypingTarget(e.target)) {
      e.preventDefault();
      openShortcutsOverlay();
      return;
    }

    if (shortcutsOverlayOpen) {
      if (e.key === "Escape") { e.preventDefault(); closeShortcutsOverlay(); }
      return;
    }

    // Item 7: Esc closes an open filter dropdown panel first, even when
    // focus is inside its type-to-filter input (which is otherwise a
    // "typing target" the dispatcher ignores below).
    if (e.key === "Escape" && $(".filter-panel:not([hidden])")) {
      e.preventDefault();
      closeAllFilterPanels();
      return;
    }

    if (e.key === "Escape" && currentView === "library" && e.target && e.target.id === "search") {
      e.preventDefault();
      e.target.value = "";
      e.target.blur();
      setSearchQuery("");
      return;
    }

    // K2: the range slider keeps native Arrow/Home/End stepping; every other
    // shortcut key falls through to the normal handling below.
    if (isRangeInput(e.target) && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      return;
    }

    if (isTypingTarget(e.target)) return;

    if (currentView === "library") {
      if (e.key === "/") {
        e.preventDefault();
        const s = $("#search");
        if (s) s.focus();
      }
      return;
    }

    // F10: keyboard must keep working while the resume prompt is up
    // (readerState is still null at that point, so the branch below can't
    // handle it). Enter accepts (resume), Esc/Backspace decline back to
    // detail — mirrors the prompt's own buttons.
    if (currentView === "reader" && resumePromptActive) {
      if (e.key === "Enter") {
        e.preventDefault();
        const btn = $("#resume-btn");
        if (btn) btn.click();
      } else if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        const bookId = resumePromptBookId;
        resumePromptActive = false;
        if (bookId) navigate("#/book/" + bookId);
      }
      return;
    }

    if (currentView === "reader" && readerState) {
      if (e.key === "ArrowRight") { e.preventDefault(); readerState.handlers.next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); readerState.handlers.prev(); }
      else if (e.key === "Home") { e.preventDefault(); readerState.handlers.first(); }
      else if (e.key === "End") { e.preventDefault(); readerState.handlers.last(); }
      else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
      else if (e.key === " " || e.key === "Spacebar") {
        // K5: fallback scroll in case the stage doesn't have native focus.
        e.preventDefault();
        scrollReaderStage(e.shiftKey ? -1 : 1);
      }
      else if (e.key === "Escape" || e.key === "Backspace") {
        // K1: let the browser exit fullscreen natively; don't also navigate
        // back and lose the reading position.
        if (e.key === "Escape" && document.fullscreenElement) return;
        e.preventDefault();
        readerState.handlers.goBack();
      }
      return;
    }

    if (currentView === "detail") {
      if (e.key === "Escape" || e.key === "Backspace") { e.preventDefault(); goHome(); }
    }
  });

  // ── Login ─────────────────────────────────────
  function showLogin() {
    currentView = "login";
    readerState = null;
    resumePromptActive = false;
    app().innerHTML = `
      <div class="login">
        <h1>Folio</h1>
        <input type="password" id="pin" placeholder="PIN" maxlength="8" autofocus>
        <button id="login-btn">Enter</button>
        <div class="error" id="login-error"></div>
      </div>`;
    const pinInput = $("#pin");
    const btn = $("#login-btn");
    const err = $("#login-error");
    async function doLogin() {
      const pin = pinInput.value;
      if (!pin) return;
      btn.disabled = true;
      try {
        const resp = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
          credentials: "same-origin"
        });
        if (!resp.ok) {
          err.textContent = resp.status === 429 ? "Too many attempts. Try again later." : "Invalid PIN";
          btn.disabled = false;
          return;
        }
        authenticated = true;
        route();
      } catch(e) { err.textContent = "Connection error"; btn.disabled = false; }
    }
    btn.onclick = doLogin;
    pinInput.onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
  }

  // ── Filter Bar (collections + series) ────────
  // Item 7: replaces the old horizontal pill strip (unusable past ~25
  // series) with two searchable dropdown panels + removable chips. Selecting
  // an entry (or removing a chip) always goes through libraryHash()+navigate
  // — a real hash push, since these are "filter clicks" per the Item 7 spec,
  // not keystrokes.
  let cachedCollections = [];
  let cachedSeries = [];

  function filterDropdownHtml(key, label) {
    return `
      <div class="filter-dropdown">
        <button class="filter-dropdown-btn" id="${key}-dropdown-btn" aria-haspopup="true" aria-expanded="false">${label} &#9662;</button>
        <div class="filter-panel" id="${key}-panel" hidden>
          <input type="text" class="filter-panel-search" id="${key}-panel-input" placeholder="Filter ${label.toLowerCase()}..." aria-label="Filter ${label.toLowerCase()}">
          <div class="filter-panel-list" id="${key}-panel-list"></div>
        </div>
      </div>`;
  }

  function closeAllFilterPanels() {
    $$(".filter-panel").forEach(p => { p.hidden = true; });
    $$(".filter-dropdown-btn").forEach(b => b.setAttribute("aria-expanded", "false"));
  }

  // A single document-level listener (bound once, not per render) closes any
  // open panel when the click lands outside it.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".filter-dropdown")) closeAllFilterPanels();
  });

  function selectFilter(key, value) {
    const next = { q: activeQuery, sort: activeSort, series: null, collection: null };
    next[key] = value;
    navigate(libraryHash(next));
  }

  function bindFilterDropdown(key, items, mapItem) {
    const btn = $(`#${key}-dropdown-btn`);
    const panel = $(`#${key}-panel`);
    const input = $(`#${key}-panel-input`);
    const list = $(`#${key}-panel-list`);
    if (!btn || !panel || !input || !list) return;

    const mapped = items.map(mapItem);

    function renderList(filterText) {
      const q = filterText.toLowerCase();
      const filtered = mapped.filter(it => !q || it.label.toLowerCase().includes(q));
      if (filtered.length === 0) {
        list.innerHTML = '<div class="filter-panel-empty">No matches</div>';
        return;
      }
      list.innerHTML = filtered.map(it => `
        <button type="button" class="filter-panel-item" data-index="${filtered.indexOf(it)}">
          <span class="filter-panel-item-name">${esc(it.label)}</span>
          <span class="filter-panel-item-count">${it.count != null ? it.count : ""}</span>
        </button>`).join("");
      list.querySelectorAll("[data-index]").forEach(el => {
        el.onclick = () => {
          selectFilter(key, filtered[parseInt(el.dataset.index, 10)].value);
          closeAllFilterPanels();
        };
      });
    }

    btn.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = !panel.hidden;
      closeAllFilterPanels();
      if (!wasOpen) {
        panel.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        input.value = "";
        renderList("");
        input.focus();
      }
    };
    panel.addEventListener("click", (e) => e.stopPropagation());
    input.oninput = () => renderList(input.value);
  }

  function chipHtml(key, label) {
    return `<span class="chip">${esc(label)}<button type="button" class="chip-remove" data-remove="${key}" aria-label="Remove ${esc(label)} filter">&times;</button></span>`;
  }

  // Renders the removable chips + the dropdown buttons' "active" styling
  // from the current activeCollectionId/activeSeries — called both after a
  // full filter-bar render and whenever the URL changes without a DOM
  // rebuild (e.g. back/forward while still viewing the library).
  function renderFilterChips() {
    const chips = $("#filter-chips");
    if (chips) {
      let html = "";
      if (activeCollectionId) {
        const c = cachedCollections.find(c => c.id === activeCollectionId);
        html += chipHtml("collection", c ? c.name : activeCollectionId);
      }
      if (activeSeries) html += chipHtml("series", activeSeries);
      chips.innerHTML = html;
      chips.querySelectorAll("[data-remove]").forEach(btn => {
        btn.onclick = () => {
          const next = { q: activeQuery, sort: activeSort, series: activeSeries, collection: activeCollectionId };
          next[btn.dataset.remove] = null;
          navigate(libraryHash(next));
        };
      });
    }
    const collBtn = $("#collection-dropdown-btn");
    if (collBtn) collBtn.classList.toggle("active", !!activeCollectionId);
    const seriesBtn = $("#series-dropdown-btn");
    if (seriesBtn) seriesBtn.classList.toggle("active", !!activeSeries);
  }

  async function renderFilterBar() {
    const bar = $("#filter-bar");
    if (!bar) return;

    const [collectionsResp, seriesResp] = await Promise.all([
      api("/api/collections"),
      api("/api/series"),
    ]);

    cachedCollections = collectionsResp ? await collectionsResp.json() : [];
    cachedSeries = seriesResp ? await seriesResp.json() : [];

    // Don't show bar if nothing to filter
    if (cachedCollections.length === 0 && cachedSeries.length === 0) {
      bar.innerHTML = "";
      return;
    }

    bar.innerHTML = `
      <button type="button" class="filter-reset" id="filter-reset-btn">All Books</button>
      ${cachedCollections.length > 0 ? filterDropdownHtml("collection", "Collections") : ""}
      ${cachedSeries.length > 0 ? filterDropdownHtml("series", "Series") : ""}
      <div class="filter-chips" id="filter-chips"></div>`;

    $("#filter-reset-btn").onclick = () => navigate("#");

    if (cachedCollections.length > 0) {
      bindFilterDropdown("collection", cachedCollections, (c) => ({ value: c.id, label: c.name, count: c.bookCount }));
    }
    if (cachedSeries.length > 0) {
      bindFilterDropdown("series", cachedSeries, (s) => ({ value: s.name, label: s.name, count: s.count }));
    }

    renderFilterChips();
  }

  // ── Library ───────────────────────────────────
  // Item 7: `params` is the already-parsed URL state (see
  // parseLibraryParams/route()) — the single source of truth. It's copied
  // into the active* module vars (a parse cache other code reads to build
  // the *next* hash) on every call, whether the DOM is being built fresh or
  // just synced to a new hash while already in the library view.
  async function showLibrary(params) {
    currentView = "library";
    flushProgressSave();
    readerState = null;
    resumePromptActive = false;

    params = params || {};
    activeQuery = params.q || "";
    activeSeries = params.series || null;
    activeCollectionId = params.collection || null;
    activeSort = params.sort || DEFAULT_SORT;

    const existing = $("#search");
    if (!existing) {
      app().innerHTML = `
        <div class="header">
          <h1>Folio</h1>
          <input type="search" id="search" placeholder="Search books..." aria-label="Search books" value="${esc(activeQuery)}">
          <select id="sort-select" aria-label="Sort by">
            <option value="date_added">Recent</option>
            <option value="title">Title</option>
            <option value="author">Author</option>
            <option value="last_read">Last Read</option>
            <option value="rating">Rating</option>
          </select>
          ${navIconsHtml("")}
        </div>
        <div class="filter-bar" id="filter-bar"></div>
        <div id="library-content"><div class="loading">Loading...</div></div>`;

      const sortSelect = $("#sort-select");
      sortSelect.value = activeSort;
      sortSelect.onchange = () => {
        // Item 7: a sort change is a "filter change", not a keystroke — a
        // real hash push, so back can step back to the previous sort.
        navigate(libraryHash({ q: activeQuery, series: activeSeries, collection: activeCollectionId, sort: sortSelect.value }));
      };

      let timer;
      $("#search").oninput = (e) => {
        clearTimeout(timer);
        const value = e.target.value;
        timer = setTimeout(() => setSearchQuery(value), 300);
      };

      bindNavIcons();
      renderFilterBar();
    } else {
      // Item 7: DOM already exists — this is a hash change while still
      // viewing the library (back/forward, a filter click, a sort change,
      // or the self-heal path in loadBooks). Sync every control to the
      // newly-parsed state instead of rebuilding.
      if (existing.value !== activeQuery) existing.value = activeQuery;
      const sortSelect = $("#sort-select");
      if (sortSelect && sortSelect.value !== activeSort) sortSelect.value = activeSort;
      renderFilterChips();
      const contentEl = $("#library-content");
      if (contentEl) contentEl.innerHTML = '<div class="loading">Loading...</div>';
    }

    await loadBooks(activeQuery);
  }

  // Item 7: keystroke search updates use history.replaceState (not a real
  // hash push) so the back button doesn't step through every character
  // typed — only the state from before the user started typing is a
  // back-stop. Shared by the debounced search input and the Esc-to-clear
  // shortcut.
  function setSearchQuery(value) {
    activeQuery = value;
    const hash = libraryHash({ q: activeQuery, series: activeSeries, collection: activeCollectionId, sort: activeSort });
    if (window.location.hash !== hash) history.replaceState(null, "", hash);
    refreshLibrary(value);
  }

  async function refreshLibrary(query) {
    const contentEl = $("#library-content");
    if (contentEl) contentEl.innerHTML = '<div class="loading">Loading...</div>';
    await loadBooks(query);
  }

  // Finding C: best-effort self-heal for a collection/series filter whose
  // underlying entity was deleted elsewhere (e.g. the desktop app) since the
  // filter bar was last rendered — without this, the active filter's fetch
  // legitimately returns zero books and the library gets stuck empty with no
  // "All Books" pill visible to escape it. Re-fetches the current
  // collections/series lists (they may have changed since the filter bar was
  // built) and reports whether the active filter's id/name is still present.
  // Never throws: an inconclusive check (network error, non-OK response)
  // reports "not missing" so a merely-empty-but-still-valid filter is left
  // alone.
  async function activeFilterEntityMissing() {
    if (activeCollectionId) {
      const resp = await api("/api/collections");
      if (!resp || !resp.ok) return false;
      const collections = await resp.json();
      return !collections.some(c => c.id === activeCollectionId);
    }
    if (activeSeries) {
      const resp = await api("/api/series");
      if (!resp || !resp.ok) return false;
      const series = await resp.json();
      return !series.some(s => s.name === activeSeries);
    }
    return false;
  }

  async function loadBooks(query) {
    // Item 5: captured once, checked after every await below — see the
    // libraryRenderGen declaration for why.
    const gen = ++libraryRenderGen;

    let url;
    if (activeCollectionId) {
      url = "/api/collections/" + encodeURIComponent(activeCollectionId) + "/books";
    } else {
      const params = new URLSearchParams();
      if (activeSeries) params.set("series", activeSeries);
      if (query) params.set("q", query);
      if (activeSort && activeSort !== "date_added") params.set("sort", activeSort);
      const qs = params.toString();
      url = "/api/books" + (qs ? "?" + qs : "");
    }

    const resp = await api(url);
    if (!resp || gen !== libraryRenderGen) return;
    const books = await resp.json();
    if (gen !== libraryRenderGen) return;

    // Finding C: an empty result for an active collection/series filter is
    // ambiguous — genuinely empty, or the filtered entity no longer exists?
    // Only the latter needs healing; a real empty collection should still
    // render as "No books found" with its filter pill active.
    if ((activeCollectionId || activeSeries) && books.length === 0) {
      const missing = await activeFilterEntityMissing();
      if (gen !== libraryRenderGen) return;
      if (missing) {
        // Item 7: URL is the source of truth — heal by navigating to the
        // hash with the dead filter dropped (a real hashchange re-runs
        // showLibrary/loadBooks), rather than mutating the parse-cache vars
        // directly and re-rendering out of step with the address bar.
        navigate(libraryHash({ q: activeQuery, sort: activeSort, series: null, collection: null }));
        return;
      }
    }

    // If collection is active and search is typed, filter client-side
    if (activeCollectionId && query) {
      const q = query.toLowerCase();
      const filtered = books.filter(b =>
        b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
      );
      renderBooks(filtered);
      return;
    }

    // Item 5: shelves only appear on the unfiltered "home" view — any active
    // search/series/collection filter (or an empty library) falls back to
    // the plain grid, matching the pre-Item-5 behavior exactly.
    const showShelves = !query && !activeCollectionId && !activeSeries && books.length > 0;

    // Finding F: render the plain grid as soon as the main books fetch
    // resolves. The shelves below are strictly best-effort decoration on top
    // of it — a shelf-fetch failure (network error, non-OK response) must
    // never leave the page stuck on "Loading".
    renderBooks(books);
    if (!showShelves) return;

    try {
      const continueResp = await api("/api/books/continue-reading?limit=12");
      if (gen !== libraryRenderGen) return;
      const continueBooks = continueResp && continueResp.ok ? await continueResp.json() : [];
      if (gen !== libraryRenderGen) return;

      // Finding H: `books` already contains `added_at` for every item, so
      // "Recently Added" can be derived client-side regardless of the active
      // sort — no need to re-fetch the whole library a second time just to
      // get it back in date-added order.
      const recentBooks = books.slice().sort((a, b) => (b.added_at || 0) - (a.added_at || 0)).slice(0, 12);

      renderLibraryWithShelves(books, continueBooks, recentBooks);
    } catch (e) {
      // Best-effort: the plain grid rendered above stays intact.
    }
  }

  function bookCardHtml(b) {
    return `
      <div class="card" data-id="${b.id}">
        <img src="/api/books/${b.id}/cover" alt="" loading="lazy">
        <div class="info">
          <div class="title">${esc(b.title)}</div>
          <div class="author">${esc(b.author)}</div>
          <div class="format">${b.format}</div>
        </div>
      </div>`;
  }

  function gridHtml(books) {
    if (books.length === 0) return '<div class="empty">No books found</div>';
    return '<div class="grid">' + books.map(bookCardHtml).join("") + '</div>';
  }

  function bindGridCardHandlers() {
    $$(".card").forEach(c => {
      c.addEventListener("click", () => navigate("#/book/" + c.dataset.id));
    });
    $$(".card img").forEach(img => {
      img.addEventListener("error", () => { img.classList.add("cover-fallback"); img.alt = "No cover"; });
    });
  }

  function renderBooks(books) {
    const contentEl = $("#library-content");
    if (contentEl) contentEl.innerHTML = gridHtml(books);
    bindGridCardHandlers();
  }

  // Item 5: percent = (chapter_index+1)/total_chapters — the same math the
  // detail page (showDetail) and the desktop app use for progress bars.
  function progressPercent(chapterIndex, totalChapters) {
    return totalChapters > 0 ? Math.round(((chapterIndex + 1) / totalChapters) * 100) : 0;
  }

  // `mode: "continue"` cards jump straight into the reader at the saved
  // position; `mode: "detail"` (Recently Added) cards behave like a normal
  // grid card and open the detail page.
  function shelfCardHtml(b, mode) {
    const bar = mode === "continue"
      ? `<div class="shelf-progress"><div class="shelf-progress-fill" style="width:${progressPercent(b.chapter_index, b.total_chapters)}%"></div></div>`
      : "";
    const posAttrs = mode === "continue"
      ? ` data-chapter-index="${b.chapter_index}" data-scroll-position="${b.scroll_position || 0}" data-last-read-at="${b.last_read_at || 0}"`
      : "";
    return `
      <div class="shelf-card" data-id="${b.id}" data-mode="${mode}"${posAttrs}>
        <img src="/api/books/${b.id}/cover" alt="" loading="lazy">
        <div class="shelf-title" title="${esc(b.title)}">${esc(b.title)}</div>
        ${bar}
      </div>`;
  }

  function shelfSectionHtml(title, books, mode) {
    if (books.length === 0) return "";
    return `
      <div class="shelf-section">
        <h2 class="shelf-heading">${esc(title)}</h2>
        <div class="shelf-row">${books.map(b => shelfCardHtml(b, mode)).join("")}</div>
      </div>`;
  }

  function bindShelfCardHandlers() {
    $$(".shelf-card").forEach(c => {
      c.addEventListener("click", () => {
        const id = c.dataset.id;
        if (c.dataset.mode === "continue") {
          // Finding B: the shelf's position was fetched at page-load time and
          // may be stale by the time it's clicked (a later save — including
          // one still in flight via the un-awaited debounced PUT — can have
          // moved this tab's actual position on). Reconcile with
          // lastKnownProgress via the same mergeProgress() the detail page's
          // Continue button uses, instead of trusting the baked-in data
          // attributes outright — same shared code path, no duplicated logic.
          const serverProgress = {
            book_id: id,
            chapter_index: parseInt(c.dataset.chapterIndex, 10) || 0,
            scroll_position: parseFloat(c.dataset.scrollPosition) || 0,
            last_read_at: parseInt(c.dataset.lastReadAt, 10) || 0,
          };
          const merged = mergeProgress(id, serverProgress) || serverProgress;
          const chapterIndex = merged.chapter_index;
          const scrollPosition = typeof merged.scroll_position === "number" ? merged.scroll_position : 0;
          readerEntryIntent = { id, action: "continue", scrollPosition };
          navigate(`#/book/${id}/${chapterIndex}/read`);
        } else {
          navigate("#/book/" + id);
        }
      });
    });
    $$(".shelf-card img").forEach(img => {
      img.addEventListener("error", () => { img.classList.add("cover-fallback"); img.alt = "No cover"; });
    });
  }

  function renderLibraryWithShelves(allBooks, continueBooks, recentBooks) {
    const contentEl = $("#library-content");
    if (!contentEl) return;

    let html = shelfSectionHtml("Continue Reading", continueBooks, "continue");
    html += shelfSectionHtml("Recently Added", recentBooks, "detail");
    html += '<h2 class="shelf-heading all-books-heading">All Books</h2>';
    html += gridHtml(allBooks);

    contentEl.innerHTML = html;
    bindShelfCardHandlers();
    bindGridCardHandlers();
  }

  // ── Detail ────────────────────────────────────
  // F6: true while `location.hash` still targets this book's detail route.
  // Re-checked after every await in showDetail so a slow response + Back
  // doesn't let a stale render clobber whatever the user navigated to.
  function hashTargetsDetail(id) {
    return (window.location.hash || "#") === `#/book/${id}`;
  }

  // F8: prefer this tab's own more-recent record of a book's progress over a
  // server GET that may have raced an in-flight PUT (e.g. right after
  // leaving the reader). Falls back to the server value when it's absent or
  // actually newer (e.g. progress made on another device/the desktop app).
  function mergeProgress(id, serverProgress) {
    const known = lastKnownProgress[id];
    if (!known) return serverProgress;
    const serverTs = serverProgress ? serverProgress.last_read_at * 1000 : 0;
    if (known.ts < serverTs) return serverProgress;
    return {
      book_id: id,
      chapter_index: known.chapterIndex,
      scroll_position: known.scrollPosition,
      last_read_at: Math.floor(known.ts / 1000),
    };
  }

  // Item 8 / Finding K: resolves this book's position among its series
  // siblings. `siblings` is the raw `/api/books?series=X` result
  // (BookGridItem[]). If ANY sibling is missing a volume number, the whole
  // series sorts by title instead — a partial volume sort (numbered books
  // first, nulls tacked on after by title) would misplace an unnumbered book
  // that actually belongs earlier in reading order. Title (then id) is
  // always the tie-breaker, so identical/duplicate volume numbers still sort
  // deterministically instead of depending on the API's row order. Returns
  // null if `id` isn't found in the list (e.g. a race with metadata edited
  // elsewhere).
  function resolveSeriesNav(siblings, id) {
    if (!siblings || siblings.length === 0) return null;
    const anyMissingVolume = siblings.some(b => b.volume == null);
    const sorted = siblings.slice().sort((a, b) => {
      if (!anyMissingVolume && a.volume !== b.volume) return a.volume - b.volume;
      return a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    const index = sorted.findIndex(b => b.id === id);
    if (index === -1) return null;
    return {
      position: index + 1,
      total: sorted.length,
      prevId: index > 0 ? sorted[index - 1].id : null,
      nextId: index < sorted.length - 1 ? sorted[index + 1].id : null,
    };
  }

  function formatFileSize(bytes) {
    if (typeof bytes !== "number" || !isFinite(bytes)) return null;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    const precision = i === 0 ? 0 : (val < 10 ? 1 : 0);
    return val.toFixed(precision) + " " + units[i];
  }

  function formatAddedDate(unixSeconds) {
    if (!unixSeconds) return null;
    try {
      return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (e) { return null; }
  }

  // Read-only star rating (1-5, rounded) — mirrors the desktop app's
  // StarRating display scale.
  function starsHtml(rating) {
    if (typeof rating !== "number") return "";
    const rounded = Math.max(0, Math.min(5, Math.round(rating)));
    let stars = "";
    for (let i = 1; i <= 5; i++) stars += i <= rounded ? "★" : "☆";
    return `<span class="detail-rating" title="Rating: ${rounded} of 5" aria-label="Rating: ${rounded} out of 5 stars">${stars}</span>`;
  }

  function seriesNavHtml(book, nav) {
    if (!book.series) return "";
    if (!nav) return `<p class="detail-series-line">Series: ${esc(book.series)}</p>`;
    const prevBtn = nav.prevId ? `<button class="btn-secondary" id="series-prev-btn">&larr; Prev</button>` : "";
    const nextBtn = nav.nextId ? `<button class="btn-secondary" id="series-next-btn">Next &rarr;</button>` : "";
    return `
      <div class="detail-series">
        <a href="#" class="series-link" id="series-link">Series: ${esc(book.series)} (${nav.position}/${nav.total})</a>
        ${(prevBtn || nextBtn) ? `<div class="series-nav-buttons">${prevBtn}${nextBtn}</div>` : ""}
      </div>`;
  }

  function progressBlockHtml(book, progress, hasProgress, isPageBased) {
    if (!hasProgress) return "";
    const total = book.total_chapters || 0;
    const current = progress.chapter_index + 1;
    const unit = isPageBased ? "Page" : "Chapter";
    // Finding G: total_chapters=0 means the page/chapter count isn't known
    // (yet) — "Chapter N of 0 · NaN%" is meaningless, so just show the
    // current position with no total/percent/bar.
    if (total <= 0) {
      return `<div class="detail-progress"><div class="detail-progress-label">${esc(`${unit} ${current}`)}</div></div>`;
    }
    const pct = progressPercent(progress.chapter_index, total);
    return `
      <div class="detail-progress">
        <div class="detail-progress-bar"><div class="detail-progress-fill" style="width:${pct}%"></div></div>
        <div class="detail-progress-label">${esc(`${unit} ${current} of ${total} · ${pct}%`)}</div>
      </div>`;
  }

  async function showDetail(id) {
    currentView = "detail";
    flushProgressSave();
    readerState = null;
    resumePromptActive = false;
    app().innerHTML = '<div class="loading">Loading...</div>';
    const resp = await api("/api/books/" + id);
    if (!resp || !hashTargetsDetail(id)) return;
    const book = await resp.json();
    if (!hashTargetsDetail(id)) return;

    const isHtmlBook = book.format === "epub" || book.format === "mobi";
    const isPageBased = ["pdf", "cbz", "cbr"].includes(book.format);
    const isReadable = isHtmlBook || isPageBased;
    const readHash = isReadable ? `#/book/${id}/0/read` : "";

    // Item 4: a book with saved progress > 0 gets Continue (jumps straight to
    // the saved position) + Start Over instead of a plain Read button. A
    // progress fetch that 404s/errors is treated the same as "no progress" —
    // never blocks the detail page from rendering.
    // Item 8: series prev/next, resolved client-side from the series's full
    // book list. Best-effort — a failed fetch just omits the nav buttons.
    // Finding I: these two fetches only depend on the book response already
    // in hand, not on each other — run them concurrently instead of one
    // after the other.
    const [progResp, seriesResp] = await Promise.all([
      isReadable ? api(`/api/books/${id}/progress`) : Promise.resolve(null),
      book.series ? api(`/api/books?series=${encodeURIComponent(book.series)}`) : Promise.resolve(null),
    ]);
    // F5/F6: a null response for a fetch that was actually made means api()
    // already redirected to the login screen (401) — continuing would render
    // the detail page over it.
    if (isReadable && !progResp) return;
    if (book.series && !seriesResp) return;
    if (!hashTargetsDetail(id)) return;

    let progress = null;
    if (isReadable) {
      if (progResp.ok) {
        try { progress = await progResp.json(); } catch (e) { progress = null; }
        if (!hashTargetsDetail(id)) return;
      }
      progress = mergeProgress(id, progress);
    }
    const hasProgress = !!(progress && progress.chapter_index > 0);
    const continueHash = isReadable ? `#/book/${id}/${progress ? progress.chapter_index : 0}/read` : "";

    let seriesNav = null;
    if (book.series && seriesResp.ok) {
      try {
        seriesNav = resolveSeriesNav(await seriesResp.json(), id);
      } catch (e) { seriesNav = null; }
      if (!hashTargetsDetail(id)) return;
    }

    let actionsHtml;
    if (!isReadable) {
      actionsHtml = "";
    } else if (hasProgress) {
      actionsHtml = `<button class="btn-primary" id="continue-btn">Continue</button><button class="btn-secondary" id="restart-btn">Start Over</button>`;
    } else {
      actionsHtml = `<button class="btn-primary" id="read-btn">Read</button>`;
    }

    const facts = [];
    if (book.total_chapters) facts.push(`${book.total_chapters} ${isPageBased ? "pages" : "chapters"}`);
    const sizeStr = formatFileSize(book.file_size);
    if (sizeStr) facts.push(sizeStr);
    const dateStr = formatAddedDate(book.added_at);
    if (dateStr) facts.push(`Added ${dateStr}`);
    const factsHtml = facts.length ? `<p class="detail-facts">${esc(facts.join(" · "))}</p>` : "";

    app().innerHTML = `
      <div class="header">
        <button class="back-btn" id="back-btn">&larr;</button>
        <h1>${esc(book.title)}</h1>
        <span style="flex:1"></span>
        ${navIconsHtml("")}
      </div>
      <div class="detail">
        <div class="meta">
          <div class="cover">
            <img src="/api/books/${id}/cover" alt="">
          </div>
          <div class="info">
            <h2>${esc(book.title)}</h2>
            <p class="detail-author">${esc(book.author)}</p>
            ${seriesNavHtml(book, seriesNav)}
            <div class="detail-badges">
              <span class="format-badge">${esc(book.format.toUpperCase())}</span>
              ${starsHtml(book.rating)}
            </div>
            ${factsHtml}
            ${book.description ? `<p class="detail-description">${esc(book.description)}</p>` : ""}
            ${progressBlockHtml(book, progress, hasProgress, isPageBased)}
            <div class="actions">
              ${actionsHtml}
              <a class="btn-secondary" href="/api/books/${id}/download">Download</a>
            </div>
          </div>
        </div>
      </div>`;
    $("#back-btn").addEventListener("click", goHome);
    bindNavIcons();
    const coverImg = $(".detail .cover img");
    if (coverImg) coverImg.addEventListener("error", () => { coverImg.classList.add("cover-fallback"); });
    const readBtn = $("#read-btn");
    if (readBtn) readBtn.addEventListener("click", () => navigate(readHash));
    const continueBtn = $("#continue-btn");
    if (continueBtn) continueBtn.addEventListener("click", () => {
      // F2b: carry the saved in-chapter scroll offset through so the reader
      // can restore it — the URL only encodes the chapter/page index.
      const scrollPosition = progress && typeof progress.scroll_position === "number" ? progress.scroll_position : 0;
      readerEntryIntent = { id, action: "continue", scrollPosition };
      navigate(continueHash);
    });
    const restartBtn = $("#restart-btn");
    if (restartBtn) restartBtn.addEventListener("click", () => {
      // F9: an explicit "Start Over" legitimately writes 0 even though it's
      // lower than anything already sent this session.
      resetProgress(id);
      readerEntryIntent = { id, action: "restart" };
      navigate(readHash);
    });
    const seriesLink = $("#series-link");
    if (seriesLink) seriesLink.addEventListener("click", (e) => {
      e.preventDefault();
      // Item 7: the URL carries the filter directly — no pending-intent
      // variable needed between this click and the library rendering it.
      navigate(libraryHash({ q: "", series: book.series, collection: null, sort: activeSort }));
    });
    const seriesPrevBtn = $("#series-prev-btn");
    if (seriesPrevBtn && seriesNav && seriesNav.prevId) {
      seriesPrevBtn.addEventListener("click", () => navigate("#/book/" + seriesNav.prevId));
    }
    const seriesNextBtn = $("#series-next-btn");
    if (seriesNextBtn && seriesNav && seriesNav.nextId) {
      seriesNextBtn.addEventListener("click", () => navigate("#/book/" + seriesNav.nextId));
    }
  }

  // ── Reader ────────────────────────────────────
  // Two modes: "page" (PDF/CBZ/CBR, images) and "chapter" (EPUB/MOBI, HTML).
  // Chrome (header + bottom toolbar) is built ONCE per book; page/chapter
  // turns within the same book only swap the stage content (renderReaderContent)
  // instead of re-fetching the book/page-count and tearing down the DOM.
  // R2/R3: true while `location.hash` still points at this reader route for
  // this book. Re-checked after every await in `showReader` so a user who
  // navigates away mid-load doesn't get a stale render clobbering whatever
  // they navigated to.
  function hashTargetsReader(id) {
    const hash = window.location.hash || "#";
    return hash.startsWith(`#/book/${id}/`) && hash.includes("/read");
  }

  // R3: clamp a possibly-malformed page/chapter index (NaN, negative,
  // out-of-range) into [0, count-1].
  function clampIndex(index, count) {
    const max = Math.max(count - 1, 0);
    if (!Number.isFinite(index)) return 0;
    return Math.min(Math.max(index, 0), max);
  }

  async function showReader(id, index) {
    currentView = "reader";

    // F7: read AND clear the entry intent right away, before any await can
    // early-return — otherwise a failed fetch below would leak it into a
    // later, unrelated reader entry and wrongly suppress its resume prompt.
    const rawIntent = readerEntryIntent && readerEntryIntent.id === id ? readerEntryIntent : null;
    readerEntryIntent = null;
    const intent = rawIntent ? rawIntent.action : null;
    const intentScroll = rawIntent && typeof rawIntent.scrollPosition === "number" ? rawIntent.scrollPosition : 0;

    const sameBook = readerState && readerState.id === id;

    if (!sameBook) {
      // R2: drop any stale state up front so a concurrent load for a
      // different book can't be mistaken for a "same book" fast path.
      // Item 4: flush first — this book may be a different one than the
      // pending debounced save belongs to.
      flushProgressSave();
      readerState = null;
      resumePromptActive = false;
      app().innerHTML = '<div class="loading">Loading...</div>';
      const resp = await api("/api/books/" + id);
      if (!resp || !hashTargetsReader(id)) return;
      if (!resp.ok) {
        app().innerHTML = `<div class="error">${esc(`Couldn't load this book (HTTP ${resp.status})`)}</div>`;
        return;
      }
      let book;
      try {
        book = await resp.json();
      } catch (e) {
        app().innerHTML = `<div class="error">${esc("Couldn't load this book (invalid response)")}</div>`;
        return;
      }
      if (!hashTargetsReader(id)) return;

      // MOBI and EPUB both render through the chapter-HTML endpoint; the
      // server-side `/api/books/:id/chapters/:index` route dispatches to
      // the right parser.
      const isHtmlBook = book.format === "epub" || book.format === "mobi";
      const mode = isHtmlBook ? "chapter" : "page";

      let count;
      if (isHtmlBook) {
        count = book.total_chapters || 1;
      } else {
        const countResp = await api(`/api/books/${id}/page-count`);
        if (!countResp || !hashTargetsReader(id)) return;
        if (!countResp.ok) {
          app().innerHTML = `<div class="error">${esc(`Couldn't load page count (HTTP ${countResp.status})`)}</div>`;
          return;
        }
        count = (await countResp.json()).count;
        if (!hashTargetsReader(id)) return;
      }

      const clamped = clampIndex(index, count);

      // Item 4: offer to resume at the saved position — but only on the
      // canonical "default open" entry point (index 0, what the detail
      // page's plain Read button always requests). A bookmarked/typed URL
      // with a specific (even out-of-range/malformed) index is an explicit
      // request for that position and must just clamp+load like before —
      // not get reinterpreted as "the user wants to resume". Also skipped
      // when the detail page's Continue/Start Over buttons already made
      // this call for this book (readerEntryIntent).
      let savedIndex = null;
      let savedScroll = 0;
      if (!intent && index === 0) {
        const progResp = await api(`/api/books/${id}/progress`);
        // F5: a null response means api() already redirected to the login
        // screen (401) — continuing would render the reader over it.
        if (!progResp || !hashTargetsReader(id)) return;
        if (progResp.ok) {
          let progress = null;
          try { progress = await progResp.json(); } catch (e) { progress = null; }
          if (progress && progress.chapter_index > 0) {
            savedIndex = clampIndex(progress.chapter_index, count);
            savedScroll = typeof progress.scroll_position === "number" ? progress.scroll_position : 0;
          }
        }
        if (!hashTargetsReader(id)) return;
      }

      if (savedIndex !== null && savedIndex !== clamped) {
        showResumePrompt(id, book, mode, count, savedIndex, clamped, savedScroll);
        return;
      }

      enterReaderAt(id, book, mode, count, clamped, intent === "continue" ? intentScroll : 0);
      if (clamped !== index) {
        // Normalize the URL; the resulting hashchange re-enters this
        // function on the "same book" fast path below to actually render.
        navigate(`#/book/${id}/${clamped}/read`);
        return;
      }
    } else {
      const clamped = clampIndex(index, readerState.count);
      readerState.index = clamped;
      if (clamped !== index) {
        navigate(`#/book/${id}/${clamped}/read`);
        return;
      }
    }

    await renderReaderContent();
  }

  // F2/F2b: `scrollPosition` (0..1, only meaningful in chapter mode) is the
  // saved in-chapter offset to restore on this specific entry — 0 for a
  // normal fresh open. `suppressNextSave` and `pendingScrollRestore` make
  // sure the very first render of this entry (the "mere open") never itself
  // schedules a progress save; see renderReaderContent().
  function enterReaderAt(id, book, mode, count, index, scrollPosition) {
    readerState = {
      id,
      book,
      mode,
      index,
      count,
      chromeHidden: false,
      fitMode: localStorage.getItem("folio_reader_fit_mode") || "fit-height",
      handlers: null,
      renderGen: 0,
      scrollPosition: mode === "chapter" ? (scrollPosition || 0) : 0,
      pendingScrollRestore: mode === "chapter" ? (scrollPosition || 0) : 0,
      suppressNextSave: true,
    };
    readerState.handlers = makeReaderHandlers(id);
    renderReaderChrome();
  }

  // Item 4: "You left off at page/chapter N" prompt shown on a fresh reader
  // entry when saved progress differs from the requested (usually 0) index.
  // F10: sets resumePromptActive/resumePromptBookId so the global keyboard
  // dispatcher can drive Enter/Esc/Backspace while this is on screen.
  function showResumePrompt(id, book, mode, count, savedIndex, restartIndex, savedScroll) {
    resumePromptActive = true;
    resumePromptBookId = id;
    const unitLabel = mode === "page" ? "Page" : "Chapter";
    app().innerHTML = `
      <div class="resume-prompt">
        <div class="resume-prompt-panel">
          <h2>${esc(book.title)}</h2>
          <p>You left off at ${unitLabel.toLowerCase()} ${savedIndex + 1} of ${count}.</p>
          <div class="resume-actions">
            <button class="btn-primary" id="resume-btn">Resume at ${unitLabel} ${savedIndex + 1}</button>
            <button class="btn-secondary" id="resume-restart-btn">Start Over</button>
          </div>
        </div>
      </div>`;
    $("#resume-btn").addEventListener("click", () => resolveResumePrompt(id, book, mode, count, savedIndex, savedScroll || 0));
    $("#resume-restart-btn").addEventListener("click", () => {
      // F9: an explicit "Start Over" legitimately writes 0 even though it's
      // lower than anything already sent this session — resetProgress()
      // clears the monotonic guard for this book before saving.
      resetProgress(id);
      resolveResumePrompt(id, book, mode, count, restartIndex, 0);
    });
  }

  async function resolveResumePrompt(id, book, mode, count, index, scrollPosition) {
    resumePromptActive = false;
    if (!hashTargetsReader(id)) return;
    // Fix the URL without firing a hashchange (avoids re-fetching book/
    // page-count/progress a second time just to confirm the same choice).
    history.replaceState(null, "", `#/book/${id}/${index}/read`);
    enterReaderAt(id, book, mode, count, index, scrollPosition || 0);
    await renderReaderContent();
  }

  function pageUrl(id, index) {
    return `/api/books/${id}/pages/${index}`;
  }

  function makeReaderHandlers(id) {
    return {
      next: () => gotoReaderIndex(readerState.index + 1),
      prev: () => gotoReaderIndex(readerState.index - 1),
      first: () => gotoReaderIndex(0),
      last: () => gotoReaderIndex(readerState.count - 1),
      goBack: () => navigate("#/book/" + id),
      toggleChrome: () => {
        readerState.chromeHidden = !readerState.chromeHidden;
        applyChromeVisibility();
      },
    };
  }

  function gotoReaderIndex(newIndex) {
    if (!readerState || newIndex < 0 || newIndex >= readerState.count) return;
    // R1-adjacent: update in-memory state synchronously so rapid successive
    // calls (e.g. holding/repeating ArrowRight) each see the just-updated
    // index rather than all reading the same stale value before the
    // asynchronous `hashchange` round-trip catches up.
    readerState.index = newIndex;
    navigate("#/book/" + readerState.id + "/" + newIndex + "/read");
  }

  function applyChromeVisibility() {
    const root = $("#reader-root");
    if (root) root.classList.toggle("chrome-hidden", readerState.chromeHidden);
  }

  function applyFitMode() {
    const root = $("#reader-root");
    if (!root) return;
    root.classList.remove("fit-height", "fit-width");
    root.classList.add(readerState.fitMode);
    const btn = $("#fit-toggle-btn");
    if (btn) btn.textContent = readerState.fitMode === "fit-height" ? "Fit: Height" : "Fit: Width";
  }

  // Left third = prev, right third = next, middle third = toggle chrome.
  function bindClickZones(el) {
    el.addEventListener("click", (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const third = rect.width / 3;
      if (x < third) readerState.handlers.prev();
      else if (x > third * 2) readerState.handlers.next();
      else readerState.handlers.toggleChrome();
    });
  }

  // Horizontal swipe (~50px threshold) = prev/next on touch devices.
  function bindSwipe(el) {
    let startX = 0, startY = 0, tracking = false;
    el.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) readerState.handlers.next();
        else readerState.handlers.prev();
      }
    }, { passive: true });
  }

  function renderReaderChrome() {
    const { book, mode, count, index, fitMode } = readerState;
    const rootClass = mode === "page" ? `reader-page ${fitMode}` : "reader-chapter";
    const stageInner = mode === "page"
      ? `<img id="page-img" alt=""><div class="reader-page-error" id="page-error" hidden></div>`
      : `<div class="content" id="reader-content"></div>`;
    const fitToggleBtn = mode === "page"
      ? `<button id="fit-toggle-btn">${fitMode === "fit-height" ? "Fit: Height" : "Fit: Width"}</button>`
      : "";

    app().innerHTML = `
      <div class="${rootClass}" id="reader-root">
        <div class="reader-chrome-top">
          <div class="header">
            <button class="back-btn" id="back-btn">&larr;</button>
            <h1>${esc(book.title)}</h1>
            <span style="flex:1"></span>
            ${navIconsHtml("")}
          </div>
        </div>
        <div class="reader-stage" id="reader-stage" tabindex="-1">${stageInner}</div>
        <div class="reader-chrome-bottom">
          <div class="reader-toolbar">
            <button id="prev-btn">Prev</button>
            <input type="range" id="page-slider" min="0" max="${count - 1}" value="${index}" aria-label="${mode === "page" ? "Page" : "Chapter"} slider">
            <span id="page-label"></span>
            <button id="next-btn">Next</button>
            ${fitToggleBtn}
          </div>
        </div>
        <button class="chrome-toggle-fab" id="chrome-toggle-btn" title="Toggle toolbar" aria-label="Toggle toolbar">&#8942;</button>
      </div>`;

    $("#back-btn").addEventListener("click", () => readerState.handlers.goBack());
    $("#prev-btn").addEventListener("click", () => readerState.handlers.prev());
    $("#next-btn").addEventListener("click", () => readerState.handlers.next());
    $("#chrome-toggle-btn").addEventListener("click", () => readerState.handlers.toggleChrome());
    $("#page-slider").addEventListener("change", (e) => {
      // K2: return focus to the document so shortcuts work immediately
      // after a slider drag, without waiting on isTypingTarget special-casing.
      e.target.blur();
      gotoReaderIndex(parseInt(e.target.value, 10));
    });
    bindNavIcons();

    if (mode === "page") {
      const img = $("#page-img");
      bindClickZones(img);
      bindSwipe(img);
      img.addEventListener("error", handlePageImageError);
      img.addEventListener("load", () => {
        img.style.display = "";
        const errEl = $("#page-error");
        if (errEl) errEl.hidden = true;
      });
      $("#fit-toggle-btn").addEventListener("click", () => {
        readerState.fitMode = readerState.fitMode === "fit-height" ? "fit-width" : "fit-height";
        localStorage.setItem("folio_reader_fit_mode", readerState.fitMode);
        applyFitMode();
      });
    } else {
      // F2b: the chrome (and its #reader-stage element) is built once per
      // book, so this listener stays bound across chapter turns — only the
      // stage's content is swapped by renderReaderContent().
      bindChapterScrollTracking($("#reader-stage"));
    }

    applyChromeVisibility();
  }

  // F2b: track the real in-chapter scroll offset as a 0..1 fraction of the
  // scrollable range (same scale as the backend's `validate_scroll_position`
  // clamp), debounced through the same save pipeline as page/chapter turns.
  function clampScrollRatio(ratio) {
    if (!Number.isFinite(ratio)) return 0;
    return Math.min(Math.max(ratio, 0), 1);
  }

  function bindChapterScrollTracking(stage) {
    if (!stage) return;
    stage.addEventListener("scroll", () => {
      if (!readerState || readerState.mode !== "chapter") return;
      // Ignore the synthetic scroll event fired by our own programmatic
      // restore (renderReaderContent) — it reflects data already saved,
      // not a new user action.
      if (readerState.suppressScrollSave) { readerState.suppressScrollSave = false; return; }
      const max = stage.scrollHeight - stage.clientHeight;
      readerState.scrollPosition = max > 0 ? clampScrollRatio(stage.scrollTop / max) : 0;
      scheduleProgressSave();
    }, { passive: true });
  }

  async function renderReaderContent() {
    const { id, mode, index, count } = readerState;
    // F8: record the navigated-to index immediately, synchronously, before
    // any await below. Previously this only happened at the tail of this
    // function (after the chapter-content fetch resolved) or on a confirmed
    // PUT response — on a slow connection, leaving the reader before either
    // of those completed left `lastKnownProgress` stale, so a showDetail()
    // GET that raced an in-flight save would win with old data (the exact
    // race F8 exists to prevent).
    recordLocalProgress(id, index, readerState.scrollPosition || 0);
    // R1: monotonic per-book render generation. Captured before each await
    // below; if it no longer matches after the await, a newer render (or a
    // fresh book load) has superseded this one — abandon without touching
    // the DOM.
    readerState.renderGen = (readerState.renderGen || 0) + 1;
    const gen = readerState.renderGen;
    // F2: consumed synchronously, right here, rather than at the end of this
    // function — an entry's first render can be abandoned by a rapid second
    // navigation before it reaches its own tail (see the R1 guards below),
    // which would otherwise leave the flag set and wrongly suppress the
    // *next* (real) navigation's save too.
    const isInitialRender = !!readerState.suppressNextSave;
    readerState.suppressNextSave = false;
    updateProgressUI();

    if (mode === "chapter") {
      const contentEl = $("#reader-content");
      if (contentEl) contentEl.innerHTML = '<div class="loading">Loading...</div>';
      const chResp = await api(`/api/books/${id}/chapters/${index}`);
      if (!readerState || readerState.renderGen !== gen) return;
      if (!chResp) return;
      // S1: non-2xx bodies are plain-text error strings that may contain
      // book-derived content (e.g. from a crafted EPUB) — never insert them
      // as HTML. Render a static, escaped message instead.
      if (!chResp.ok) {
        if (contentEl) {
          contentEl.innerHTML = `<div class="reader-error">${esc(`Couldn't load this chapter (HTTP ${chResp.status})`)}</div>`;
        }
        return;
      }
      const html = await chResp.text();
      if (!readerState || readerState.renderGen !== gen) return;
      if (contentEl) contentEl.innerHTML = html;
      // K5: native Space/PageDown scrolling needs the scroll container focused.
      const stage = $("#reader-stage");
      if (stage) {
        stage.focus();
        // F2b: restore the saved in-chapter offset on this entry only —
        // `pendingScrollRestore` is consumed once and is 0 for a normal
        // chapter turn, which just lands at the top like before.
        const restoreRatio = readerState.pendingScrollRestore || 0;
        readerState.pendingScrollRestore = 0;
        requestAnimationFrame(() => {
          if (!readerState || readerState.renderGen !== gen) return;
          const max = stage.scrollHeight - stage.clientHeight;
          if (restoreRatio > 0 && max > 0) {
            readerState.suppressScrollSave = true;
            stage.scrollTop = restoreRatio * max;
          } else {
            stage.scrollTop = 0;
          }
        });
      }
    } else {
      const img = $("#page-img");
      if (img) {
        img.src = pageUrl(id, index);
        img.alt = `Page ${index + 1} of ${count}`;
      }
      // Preload neighbors so turns feel instant; browser HTTP cache does the rest.
      if (index + 1 < count) new Image().src = pageUrl(id, index + 1);
      if (index - 1 >= 0) new Image().src = pageUrl(id, index - 1);
    }

    // F2: a mere open (or resume/restart choice, which is also just an open)
    // must never itself persist a save — only a real subsequent navigation
    // or scroll should.
    if (!isInitialRender) {
      scheduleProgressSave();
    }
  }

  // ── Item 4: reading progress sync ──────────────
  // Debounced save while turning pages/chapters or scrolling within a
  // chapter, flushed immediately on tab hide / navigation-away so a closed
  // tab never loses the last position.
  const PROGRESS_SAVE_DEBOUNCE_MS = 2000;
  let progressSaveTimer = null;

  // F8: record this tab's most recent progress immediately (before the
  // network round trip), so showDetail() can prefer it over a GET that may
  // have raced an in-flight save.
  function recordLocalProgress(id, chapterIndex, scrollPosition) {
    lastKnownProgress[id] = { chapterIndex, scrollPosition, ts: Date.now() };
  }

  // F9: the actual network write, run one-at-a-time per book via
  // queueProgressSave's promise chain. Drops an out-of-order save that would
  // regress this session's high-water mark for the book, unless `reset` is
  // set (an explicit "Start Over").
  async function sendProgress(id, chapterIndex, scrollPosition, opts) {
    opts = opts || {};
    if (!opts.reset && lastSentIndex[id] !== undefined && chapterIndex < lastSentIndex[id]) {
      return;
    }
    try {
      const resp = await fetch(`/api/books/${id}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapter_index: chapterIndex, scroll_position: scrollPosition }),
        credentials: "same-origin",
        keepalive: true,
      });
      // F3: a debounced/flushed save (unlike the pagehide teardown flush)
      // can and should react to an expired session — route to the same
      // login redirect the rest of the app uses.
      if (resp.status === 401) {
        authenticated = false;
        showLogin();
        return;
      }
      if (resp.ok) {
        lastSentIndex[id] = chapterIndex;
        recordLocalProgress(id, chapterIndex, scrollPosition);
      }
    } catch (e) {
      // Network error: best-effort save, nothing more to do.
    }
  }

  // F9: serializes saves per book so a debounced save and a later flush can
  // never commit out of order — the next save always waits for the previous
  // one's response before firing.
  function queueProgressSave(id, chapterIndex, scrollPosition, opts) {
    const prev = saveChains[id] || Promise.resolve();
    const next = prev.then(() => sendProgress(id, chapterIndex, scrollPosition, opts));
    saveChains[id] = next.catch(() => {});
    return next;
  }

  // F9: explicit "Start Over" — legitimately writes 0 even though it's lower
  // than anything already sent this session, so it resets the guard first.
  function resetProgress(id) {
    delete lastSentIndex[id];
    recordLocalProgress(id, 0, 0);
    return queueProgressSave(id, 0, 0, { reset: true });
  }

  function scheduleProgressSave() {
    if (!readerState) return;
    recordLocalProgress(readerState.id, readerState.index, readerState.scrollPosition || 0);
    clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(flushProgressSave, PROGRESS_SAVE_DEBOUNCE_MS);
  }

  function flushProgressSave() {
    clearTimeout(progressSaveTimer);
    progressSaveTimer = null;
    if (!readerState) return;
    const { id, index, scrollPosition } = readerState;
    return queueProgressSave(id, index, scrollPosition || 0);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushProgressSave();
  });
  // F3: the pagehide teardown flush stays fire-and-forget — the page may be
  // gone before a 401 check could do anything useful with it anyway.
  window.addEventListener("pagehide", flushProgressSave);

  // R4: page-mode turns only ever set img.src, so a 401 on session expiry
  // fails silently (broken image, no redirect to login). Probe a cheap
  // authenticated endpoint — api() already redirects to login on 401 — to
  // distinguish "session expired" from a genuine image failure.
  async function handlePageImageError() {
    if (!readerState) return;
    const check = await api(`/api/books/${readerState.id}`);
    if (!check) return; // 401 — api() already redirected to the login screen
    const img = $("#page-img");
    const errEl = $("#page-error");
    if (img) img.style.display = "none";
    if (errEl) {
      errEl.hidden = false;
      errEl.innerHTML = esc("Couldn't load this page.");
    }
  }

  // K5: fallback for Space/Shift+Space when the stage doesn't have native
  // focus. Scrolls by ~90% of the visible stage height.
  function scrollReaderStage(direction) {
    const stage = $("#reader-stage");
    if (!stage) return;
    stage.scrollBy({ top: stage.clientHeight * 0.9 * direction, behavior: "auto" });
  }

  function updateProgressUI() {
    const { mode, index, count } = readerState;
    const label = $("#page-label");
    if (label) label.textContent = `${mode === "page" ? "Page" : "Chapter"} ${index + 1} / ${count}`;
    const slider = $("#page-slider");
    if (slider) slider.value = index;
    const prevBtn = $("#prev-btn");
    const nextBtn = $("#next-btn");
    if (prevBtn) prevBtn.disabled = index <= 0;
    if (nextBtn) nextBtn.disabled = index >= count - 1;
  }

  // ── Stats ──────────────────────────────────────
  async function showStats() {
    currentView = "stats";
    flushProgressSave();
    readerState = null;
    resumePromptActive = false;
    app().innerHTML = `
      <div class="header">
        <button class="back-btn" id="back-btn">&larr;</button>
        <h1>Reading Stats</h1>
        <span style="flex:1"></span>
        ${navIconsHtml("stats")}
      </div>
      <div class="stats"><div class="loading">Loading...</div></div>`;
    $("#back-btn").addEventListener("click", goHome);
    bindNavIcons();

    const resp = await api("/api/stats");
    if (!resp) return;
    const s = await resp.json();

    const container = $(".stats");
    if (!s || (s.totalSessions === 0 && s.totalReadingTimeSecs === 0)) {
      container.innerHTML = '<div class="empty">No reading stats yet. Start reading on the desktop app to see your progress here.</div>';
      return;
    }

    const maxDaily = s.dailyReading.reduce((max, entry) => Math.max(max, entry[1]), 0);

    let chartHtml = "";
    if (s.dailyReading.length > 0 && maxDaily > 0) {
      const bars = s.dailyReading.map(([date, secs]) => {
        const pct = Math.max(4, (secs / maxDaily) * 100);
        return `<div class="stat-bar" style="height:${pct}%" title="${date}: ${formatDuration(secs)}"></div>`;
      }).join("");
      chartHtml = `
        <div class="stat-chart-header">
          <div class="stat-chart-title">Last 30 Days</div>
          <div class="stat-chart-peak">${formatDuration(maxDaily)} peak</div>
        </div>
        <div class="stat-chart">${bars}</div>`;
    }

    const streak = (d) => d === 1 ? "1 day" : d + " days";

    container.innerHTML = `
      <div class="stat-cards">
        <div class="stat-card"><div class="stat-value">${formatDuration(s.totalReadingTimeSecs)}</div><div class="stat-label">Time Reading</div></div>
        <div class="stat-card"><div class="stat-value">${s.totalSessions}</div><div class="stat-label">Sessions</div></div>
        <div class="stat-card"><div class="stat-value">${s.totalPagesRead.toLocaleString()}</div><div class="stat-label">Pages Read</div></div>
        <div class="stat-card"><div class="stat-value">${s.booksFinished}</div><div class="stat-label">Books Finished</div></div>
        <div class="stat-card"><div class="stat-value accent">${streak(s.currentStreakDays)}</div><div class="stat-label">Current Streak</div></div>
        <div class="stat-card"><div class="stat-value">${streak(s.longestStreakDays)}</div><div class="stat-label">Longest Streak</div></div>
      </div>
      ${chartHtml}`;
  }

  // ── Collections ────────────────────────────────
  async function showCollections() {
    currentView = "collections";
    flushProgressSave();
    readerState = null;
    resumePromptActive = false;
    app().innerHTML = `
      <div class="header">
        <button class="back-btn" id="back-btn">&larr;</button>
        <h1>Collections</h1>
        <span style="flex:1"></span>
        ${navIconsHtml("collections")}
      </div>
      <div class="collections"><div class="loading">Loading...</div></div>`;
    $("#back-btn").addEventListener("click", goHome);
    bindNavIcons();

    const [collectionsResp, seriesResp] = await Promise.all([
      api("/api/collections"),
      api("/api/series"),
    ]);

    const collections = collectionsResp ? await collectionsResp.json() : [];
    const series = seriesResp ? await seriesResp.json() : [];

    const container = $(".collections");
    if (collections.length === 0 && series.length === 0) {
      container.innerHTML = '<div class="empty">No collections yet. Create collections in the desktop app.</div>';
      return;
    }

    let sortAsc = true;
    let filterText = "";

    function render() {
      const q = filterText.toLowerCase();
      const filteredColls = collections
        .filter(c => !q || c.name.toLowerCase().includes(q))
        .sort((a, b) => sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
      const filteredSeries = series
        .filter(s => !q || s.name.toLowerCase().includes(q))
        .sort((a, b) => sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));

      let html = `<div class="collections-toolbar">
        <input type="text" id="coll-filter" placeholder="Filter collections..." value="${esc(filterText)}">
        <button class="sort-btn" id="coll-sort">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5h10M11 9h7M11 13h4"/><path d="M3 17l3 3 3-3M6 18V4"/></svg>
          ${sortAsc ? "A→Z" : "Z→A"}
        </button>
      </div>`;

      if (filteredColls.length > 0) {
        html += `<div class="section-header">Collections <span class="count">(${filteredColls.length})</span></div>`;
        html += '<div class="collection-list">';
        for (const c of filteredColls) {
          const icon = c.icon || "📁";
          const colorSwatch = c.color ? `<span class="collection-color" style="background:${esc(c.color)}"></span>` : "";
          const typeBadge = c.type === "automated"
            ? '<span class="auto-dot"></span>Auto-collection'
            : "Manual collection";
          const count = c.bookCount !== undefined ? c.bookCount : "?";
          html += `<div class="collection-row" data-collection-id="${c.id}">
            <span class="collection-icon">${icon}</span>
            <div class="collection-info">
              <div class="collection-name">${colorSwatch}${esc(c.name)}</div>
              <div class="collection-type">${typeBadge}</div>
            </div>
            <span class="collection-count">${count} book${count !== 1 ? "s" : ""}</span>
            <span class="collection-chevron">&rsaquo;</span>
          </div>`;
        }
        html += '</div>';
      }

      if (filteredSeries.length > 0) {
        html += `<div class="section-header">Series <span class="count">(${filteredSeries.length})</span></div>`;
        html += '<div class="collection-list">';
        for (const s of filteredSeries) {
          html += `<div class="collection-row" data-series-name="${esc(s.name)}">
            <span class="collection-icon" style="display:flex;align-items:center;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
            </span>
            <div class="collection-info">
              <div class="collection-name">${esc(s.name)}</div>
            </div>
            <span class="collection-count">${s.count} book${s.count !== 1 ? "s" : ""}</span>
            <span class="collection-chevron">&rsaquo;</span>
          </div>`;
        }
        html += '</div>';
      }

      if (filteredColls.length === 0 && filteredSeries.length === 0) {
        html += '<div class="empty">No matches</div>';
      }

      container.innerHTML = html;

      const filterInput = $("#coll-filter");
      let filterTimer;
      filterInput.oninput = (e) => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => { filterText = e.target.value; render(); }, 200);
      };
      filterInput.focus();

      $("#coll-sort").onclick = () => { sortAsc = !sortAsc; render(); };

      container.querySelectorAll("[data-collection-id]").forEach(row => {
        row.onclick = () => {
          navigate(libraryHash({ q: "", series: null, collection: row.dataset.collectionId, sort: activeSort }));
        };
      });
      container.querySelectorAll("[data-series-name]").forEach(row => {
        row.onclick = () => {
          navigate(libraryHash({ q: "", series: row.dataset.seriesName, collection: null, sort: activeSort }));
        };
      });
    }

    render();
  }

  // ── Helpers ───────────────────────────────────
  // Security (finding A): textContent -> innerHTML only escapes text-node
  // metacharacters (&, <, >) — it leaves " and ' untouched, since those are
  // only special in attribute context. Every caller of esc() in this file
  // interpolates its result into either a text node OR a quoted HTML
  // attribute (e.g. `title="${esc(b.title)}"`), so the escaping must be safe
  // for both: without this, a title/author/series/collection name containing
  // `"` could break out of an attribute and inject arbitrary markup/handlers.
  function esc(s) {
    if (!s) return "";
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatDuration(secs) {
    if (!secs || secs < 60) return "< 1m";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h === 0) return m + "m";
    return h + "h " + m + "m";
  }

  // Item 6: sun (light) / moon (dark) / half-filled circle (system) — no
  // icon library, inline SVG only, matching the rest of the nav icons.
  function themeIconSvg(mode) {
    if (mode === "light") {
      return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
    }
    if (mode === "dark") {
      return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>';
  }

  function themeToggleHtml() {
    const label = themeAriaLabel();
    return `<button class="nav-icon" id="theme-toggle-btn" title="${esc(label)}" aria-label="${esc(label)}">${themeIconSvg(themeMode)}</button>`;
  }

  // Item 6: light -> dark -> system -> light. "system" removes data-theme
  // entirely so the CSS prefers-color-scheme block takes back over.
  function cycleTheme() {
    themeMode = themeMode === "light" ? "dark" : themeMode === "dark" ? "system" : "light";
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    applyTheme();
    const btn = $("#theme-toggle-btn");
    if (btn) btn.innerHTML = themeIconSvg(themeMode);
    updateThemeButtonLabel();
  }

  function navIconsHtml(activePage) {
    const folderColor = activePage === "collections" ? "active" : "";
    const chartColor = activePage === "stats" ? "active" : "";
    return `<div class="nav-icons">
      ${themeToggleHtml()}
      <button class="nav-icon ${folderColor}" title="Collections" data-nav="collections">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      </button>
      <button class="nav-icon ${chartColor}" title="Reading Stats" data-nav="stats">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
      </button>
    </div>`;
  }

  function bindNavIcons() {
    $$("[data-nav]").forEach(btn => {
      btn.onclick = () => navigate("#/" + btn.dataset.nav);
    });
    const themeBtn = $("#theme-toggle-btn");
    if (themeBtn) themeBtn.onclick = cycleTheme;
  }

  // ── Init ──────────────────────────────────────
  async function init() {
    const test = await fetch("/api/books", { credentials: "same-origin" });
    if (test.status === 401) { showLogin(); return; }
    authenticated = true;
    route();
  }

  init();
})();
