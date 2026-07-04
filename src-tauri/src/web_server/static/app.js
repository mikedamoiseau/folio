(function() {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const app = () => $("#app");

  // R3-4: Use httpOnly cookies only — no localStorage token storage
  let authenticated = false;

  // Active filter state
  let activeCollectionId = null;
  let activeSeries = null;
  let activeSort = "date_added";

  // R2-3/R3-1: current view + reader state, used by the global keyboard
  // shortcut dispatcher and by the reader's own nav handlers.
  let currentView = null; // "login" | "library" | "detail" | "reader" | "stats" | "collections"
  let readerState = null; // set while currentView === "reader"; see showReader()
  let shortcutsOverlayOpen = false;

  async function api(path) {
    const resp = await fetch(path, { credentials: "same-origin" });
    if (resp.status === 401) { authenticated = false; showLogin(); return null; }
    return resp;
  }

  // ── Router ────────────────────────────────────
  function navigate(hash) {
    window.location.hash = hash;
  }

  function route() {
    const hash = window.location.hash || "#";
    if (hash === "#" || hash === "#/") return showLibrary();
    if (hash === "#/stats") return showStats();
    if (hash === "#/collections") return showCollections();
    if (hash.startsWith("#/book/") && hash.includes("/read")) {
      const parts = hash.replace("#/book/", "").replace("/read", "").split("/");
      return showReader(parts[0], parseInt(parts[1] || "0"));
    }
    if (hash.startsWith("#/book/")) return showDetail(hash.replace("#/book/", ""));
    showLibrary();
  }

  window.addEventListener("hashchange", route);

  // ── Keyboard Shortcuts ────────────────────────
  // Single listener, dispatches on `currentView`. See docs/web-ui-improvements.md
  // Item 2 for the key map.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
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
    if (e.key === "?" && !isTypingTarget(e.target)) {
      e.preventDefault();
      openShortcutsOverlay();
      return;
    }

    if (shortcutsOverlayOpen) {
      if (e.key === "Escape") { e.preventDefault(); closeShortcutsOverlay(); }
      return;
    }

    if (e.key === "Escape" && currentView === "library" && e.target && e.target.id === "search") {
      e.preventDefault();
      e.target.value = "";
      e.target.blur();
      refreshLibrary("");
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

    if (currentView === "reader" && readerState) {
      if (e.key === "ArrowRight") { e.preventDefault(); readerState.handlers.next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); readerState.handlers.prev(); }
      else if (e.key === "Home") { e.preventDefault(); readerState.handlers.first(); }
      else if (e.key === "End") { e.preventDefault(); readerState.handlers.last(); }
      else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
      else if (e.key === "Escape" || e.key === "Backspace") { e.preventDefault(); readerState.handlers.goBack(); }
      return;
    }

    if (currentView === "detail") {
      if (e.key === "Escape" || e.key === "Backspace") { e.preventDefault(); navigate("#"); }
    }
  });

  // ── Login ─────────────────────────────────────
  function showLogin() {
    currentView = "login";
    readerState = null;
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
  async function renderFilterBar() {
    const bar = $("#filter-bar");
    if (!bar) return;

    const [collectionsResp, seriesResp] = await Promise.all([
      api("/api/collections"),
      api("/api/series"),
    ]);

    const collections = collectionsResp ? await collectionsResp.json() : [];
    const series = seriesResp ? await seriesResp.json() : [];

    // Don't show bar if nothing to filter
    if (collections.length === 0 && series.length === 0) {
      bar.innerHTML = "";
      return;
    }

    let html = '<div class="filter-pills">';
    html += `<button class="pill ${!activeCollectionId && !activeSeries ? "active" : ""}" data-filter="all">All Books</button>`;

    if (collections.length > 0) {
      html += '<span class="filter-sep">|</span>';
      for (const c of collections) {
        const active = activeCollectionId === c.id ? "active" : "";
        html += `<button class="pill ${active}" data-collection="${c.id}">${esc(c.name)}</button>`;
      }
    }

    if (series.length > 0) {
      html += '<span class="filter-sep">|</span>';
      for (const s of series) {
        const active = activeSeries === s.name ? "active" : "";
        html += `<button class="pill ${active}" data-series="${esc(s.name)}">${esc(s.name)} <span class="pill-count">${s.count}</span></button>`;
      }
    }

    html += "</div>";
    bar.innerHTML = html;

    // Bind click handlers
    bar.querySelectorAll("[data-filter='all']").forEach(btn => {
      btn.onclick = () => { activeCollectionId = null; activeSeries = null; refreshLibrary(); };
    });
    bar.querySelectorAll("[data-collection]").forEach(btn => {
      btn.onclick = () => {
        activeCollectionId = btn.dataset.collection;
        activeSeries = null;
        refreshLibrary();
      };
    });
    bar.querySelectorAll("[data-series]").forEach(btn => {
      btn.onclick = () => {
        activeSeries = btn.dataset.series;
        activeCollectionId = null;
        refreshLibrary();
      };
    });
  }

  function updateFilterBarActive() {
    const bar = $("#filter-bar");
    if (!bar) return;
    bar.querySelectorAll(".pill").forEach(btn => {
      btn.classList.remove("active");
      if (btn.dataset.filter === "all" && !activeCollectionId && !activeSeries) btn.classList.add("active");
      if (btn.dataset.collection && btn.dataset.collection === activeCollectionId) btn.classList.add("active");
      if (btn.dataset.series && btn.dataset.series === activeSeries) btn.classList.add("active");
    });
  }

  // ── Library ───────────────────────────────────
  async function showLibrary(query) {
    currentView = "library";
    readerState = null;
    const existing = $("#search");
    if (!existing) {
      activeCollectionId = null;
      activeSeries = null;
      app().innerHTML = `
        <div class="header">
          <h1>Folio</h1>
          <input type="search" id="search" placeholder="Search books..." value="${esc(query || "")}">
          <select id="sort-select" aria-label="Sort by">
            <option value="date_added">Recent</option>
            <option value="title">Title</option>
            <option value="author">Author</option>
            <option value="last_read">Last Read</option>
            <option value="rating">Rating</option>
          </select>
          ${navIconsHtml("")}
        </div>
        <div id="filter-bar"></div>
        <div id="library-content"><div class="loading">Loading...</div></div>`;

      const sortSelect = $("#sort-select");
      sortSelect.value = activeSort;
      sortSelect.onchange = () => { activeSort = sortSelect.value; refreshLibrary(); };

      let timer;
      $("#search").oninput = (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => refreshLibrary(e.target.value), 300);
      };

      bindNavIcons();

      // Load filter bar (collections + series)
      renderFilterBar();
    } else {
      const contentEl = $("#library-content");
      if (contentEl) contentEl.innerHTML = '<div class="loading">Loading...</div>';
    }

    await loadBooks(query);
  }

  async function refreshLibrary(query) {
    const searchEl = $("#search");
    const q = query !== undefined ? query : (searchEl ? searchEl.value : "");
    updateFilterBarActive();
    const contentEl = $("#library-content");
    if (contentEl) contentEl.innerHTML = '<div class="loading">Loading...</div>';
    await loadBooks(q);
  }

  async function loadBooks(query) {
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
    if (!resp) return;
    const books = await resp.json();

    // If collection is active and search is typed, filter client-side
    if (activeCollectionId && query) {
      const q = query.toLowerCase();
      const filtered = books.filter(b =>
        b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
      );
      renderBooks(filtered);
    } else {
      renderBooks(books);
    }
  }

  function renderBooks(books) {
    let content;
    if (books.length === 0) {
      content = '<div class="empty">No books found</div>';
    } else {
      content = '<div class="grid">' + books.map(b => `
        <div class="card" data-id="${b.id}">
          <img src="/api/books/${b.id}/cover" alt="" loading="lazy">
          <div class="info">
            <div class="title">${esc(b.title)}</div>
            <div class="author">${esc(b.author)}</div>
            <div class="format">${b.format}</div>
          </div>
        </div>`).join("") + '</div>';
    }

    const contentEl = $("#library-content");
    if (contentEl) contentEl.innerHTML = content;

    $$(".card").forEach(c => {
      c.addEventListener("click", () => navigate("#/book/" + c.dataset.id));
    });
    $$(".card img").forEach(img => {
      img.addEventListener("error", () => { img.classList.add("cover-fallback"); img.alt = "No cover"; });
    });
  }

  // ── Detail ────────────────────────────────────
  async function showDetail(id) {
    currentView = "detail";
    readerState = null;
    app().innerHTML = '<div class="loading">Loading...</div>';
    const resp = await api("/api/books/" + id);
    if (!resp) return;
    const book = await resp.json();

    const isHtmlBook = book.format === "epub" || book.format === "mobi";
    const isPageBased = ["pdf", "cbz", "cbr"].includes(book.format);
    const readHash = isHtmlBook || isPageBased ? `#/book/${id}/0/read` : "";

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
            <p>${esc(book.author)}</p>
            <p>Format: ${book.format.toUpperCase()}</p>
            ${book.description ? `<p>${esc(book.description)}</p>` : ""}
            <div class="actions">
              ${readHash ? `<button class="btn-primary" id="read-btn">Read</button>` : ""}
              <a class="btn-secondary" href="/api/books/${id}/download">Download</a>
            </div>
          </div>
        </div>
      </div>`;
    $("#back-btn").addEventListener("click", () => navigate("#"));
    bindNavIcons();
    const coverImg = $(".detail .cover img");
    if (coverImg) coverImg.addEventListener("error", () => { coverImg.classList.add("cover-fallback"); });
    const readBtn = $("#read-btn");
    if (readBtn) readBtn.addEventListener("click", () => navigate(readHash));
  }

  // ── Reader ────────────────────────────────────
  // Two modes: "page" (PDF/CBZ/CBR, images) and "chapter" (EPUB/MOBI, HTML).
  // Chrome (header + bottom toolbar) is built ONCE per book; page/chapter
  // turns within the same book only swap the stage content (renderReaderContent)
  // instead of re-fetching the book/page-count and tearing down the DOM.
  async function showReader(id, index) {
    currentView = "reader";
    const sameBook = readerState && readerState.id === id;

    if (!sameBook) {
      app().innerHTML = '<div class="loading">Loading...</div>';
      const resp = await api("/api/books/" + id);
      if (!resp) return;
      const book = await resp.json();

      // MOBI and EPUB both render through the chapter-HTML endpoint; the
      // server-side `/api/books/:id/chapters/:index` route dispatches to
      // the right parser.
      const isHtmlBook = book.format === "epub" || book.format === "mobi";

      let count;
      if (isHtmlBook) {
        count = book.total_chapters || 1;
      } else {
        const countResp = await api(`/api/books/${id}/page-count`);
        if (!countResp) return;
        count = (await countResp.json()).count;
      }

      readerState = {
        id,
        book,
        mode: isHtmlBook ? "chapter" : "page",
        index,
        count,
        chromeHidden: false,
        fitMode: localStorage.getItem("folio_reader_fit_mode") || "fit-height",
        handlers: null,
      };
      readerState.handlers = makeReaderHandlers(id);
      renderReaderChrome();
    } else {
      readerState.index = index;
    }

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
      ? `<img id="page-img" alt="">`
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
        <div class="reader-stage" id="reader-stage">${stageInner}</div>
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
    $("#page-slider").addEventListener("change", (e) => gotoReaderIndex(parseInt(e.target.value, 10)));
    bindNavIcons();

    if (mode === "page") {
      const img = $("#page-img");
      bindClickZones(img);
      bindSwipe(img);
      $("#fit-toggle-btn").addEventListener("click", () => {
        readerState.fitMode = readerState.fitMode === "fit-height" ? "fit-width" : "fit-height";
        localStorage.setItem("folio_reader_fit_mode", readerState.fitMode);
        applyFitMode();
      });
    }

    applyChromeVisibility();
  }

  async function renderReaderContent() {
    const { id, mode, index, count } = readerState;
    updateProgressUI();

    if (mode === "chapter") {
      const contentEl = $("#reader-content");
      if (contentEl) contentEl.innerHTML = '<div class="loading">Loading...</div>';
      const chResp = await api(`/api/books/${id}/chapters/${index}`);
      if (!chResp) return;
      const html = await chResp.text();
      if (contentEl) contentEl.innerHTML = html;
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
    readerState = null;
    app().innerHTML = `
      <div class="header">
        <button class="back-btn" id="back-btn">&larr;</button>
        <h1>Reading Stats</h1>
        <span style="flex:1"></span>
        ${navIconsHtml("stats")}
      </div>
      <div class="stats"><div class="loading">Loading...</div></div>`;
    $("#back-btn").addEventListener("click", () => navigate("#"));
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
    readerState = null;
    app().innerHTML = `
      <div class="header">
        <button class="back-btn" id="back-btn">&larr;</button>
        <h1>Collections</h1>
        <span style="flex:1"></span>
        ${navIconsHtml("collections")}
      </div>
      <div class="collections"><div class="loading">Loading...</div></div>`;
    $("#back-btn").addEventListener("click", () => navigate("#"));
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
          activeCollectionId = row.dataset.collectionId;
          activeSeries = null;
          navigate("#/");
        };
      });
      container.querySelectorAll("[data-series-name]").forEach(row => {
        row.onclick = () => {
          activeSeries = row.dataset.seriesName;
          activeCollectionId = null;
          navigate("#/");
        };
      });
    }

    render();
  }

  // ── Helpers ───────────────────────────────────
  function esc(s) {
    if (!s) return "";
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function formatDuration(secs) {
    if (!secs || secs < 60) return "< 1m";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h === 0) return m + "m";
    return h + "h " + m + "m";
  }

  function navIconsHtml(activePage) {
    const folderColor = activePage === "collections" ? "active" : "";
    const chartColor = activePage === "stats" ? "active" : "";
    return `<div class="nav-icons">
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
