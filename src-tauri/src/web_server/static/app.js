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
    if (hash.startsWith("#/book/") && hash.includes("/read")) {
      const parts = hash.replace("#/book/", "").replace("/read", "").split("/");
      return showReader(parts[0], parseInt(parts[1] || "0"));
    }
    if (hash.startsWith("#/book/")) return showDetail(hash.replace("#/book/", ""));
    showLibrary();
  }

  window.addEventListener("hashchange", route);

  // ── Login ─────────────────────────────────────
  function showLogin() {
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
      img.addEventListener("error", () => { img.style.background = "#333"; img.alt = "No cover"; });
    });
  }

  // ── Detail ────────────────────────────────────
  async function showDetail(id) {
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
    const coverImg = $(".detail .cover img");
    if (coverImg) coverImg.addEventListener("error", () => { coverImg.style.background = "#333"; });
    const readBtn = $("#read-btn");
    if (readBtn) readBtn.addEventListener("click", () => navigate(readHash));
  }

  // ── Reader ────────────────────────────────────
  async function showReader(id, index) {
    app().innerHTML = '<div class="loading">Loading...</div>';
    const resp = await api("/api/books/" + id);
    if (!resp) return;
    const book = await resp.json();

    // MOBI and EPUB both render through the chapter-HTML endpoint; the
    // server-side `/api/books/:id/chapters/:index` route dispatches to
    // the right parser.
    const isHtmlBook = book.format === "epub" || book.format === "mobi";

    if (isHtmlBook) {
      const chResp = await api(`/api/books/${id}/chapters/${index}`);
      if (!chResp) return;
      const html = await chResp.text();
      const total = book.total_chapters || 1;

      app().innerHTML = `
        <div class="header">
          <button class="back-btn" id="back-btn">&larr;</button>
          <h1>${esc(book.title)}</h1>
        </div>
        <div class="reader">
          <div class="nav">
            <button id="prev-btn" ${index <= 0 ? "disabled" : ""}>Prev</button>
            <span>Chapter ${index + 1} / ${total}</span>
            <button id="next-btn" ${index >= total - 1 ? "disabled" : ""}>Next</button>
          </div>
          <div class="content">${html}</div>
        </div>`;
      $("#back-btn").addEventListener("click", () => navigate("#/book/" + id));
      $("#prev-btn").addEventListener("click", () => navigate("#/book/" + id + "/" + (index - 1) + "/read"));
      $("#next-btn").addEventListener("click", () => navigate("#/book/" + id + "/" + (index + 1) + "/read"));
    } else {
      const countResp = await api(`/api/books/${id}/page-count`);
      if (!countResp) return;
      const { count } = await countResp.json();

      app().innerHTML = `
        <div class="header">
          <button class="back-btn" id="back-btn">&larr;</button>
          <h1>${esc(book.title)}</h1>
        </div>
        <div class="reader">
          <div class="nav">
            <button id="prev-btn" ${index <= 0 ? "disabled" : ""}>Prev</button>
            <span>Page ${index + 1} / ${count}</span>
            <button id="next-btn" ${index >= count - 1 ? "disabled" : ""}>Next</button>
          </div>
          <div class="page-img">
            <img src="/api/books/${id}/pages/${index}" alt="Page ${index + 1}">
          </div>
        </div>`;
      $("#back-btn").addEventListener("click", () => navigate("#/book/" + id));
      $("#prev-btn").addEventListener("click", () => navigate("#/book/" + id + "/" + (index - 1) + "/read"));
      $("#next-btn").addEventListener("click", () => navigate("#/book/" + id + "/" + (index + 1) + "/read"));
    }
  }

  // ── Helpers ───────────────────────────────────
  function esc(s) {
    if (!s) return "";
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
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
