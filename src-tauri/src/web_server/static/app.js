(function() {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const app = () => $("#app");

  // R3-4: Use httpOnly cookies only — no localStorage token storage
  let authenticated = false;

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

  // ── Library ───────────────────────────────────
  async function showLibrary(query) {
    // Only rebuild the full layout if the header/search doesn't exist yet
    const existing = $("#search");
    if (!existing) {
      app().innerHTML = `
        <div class="header">
          <h1>Folio</h1>
          <input type="search" id="search" placeholder="Search books..." value="${esc(query || "")}">
        </div>
        <div id="library-content"><div class="loading">Loading...</div></div>`;

      let timer;
      $("#search").oninput = (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => showLibrary(e.target.value), 300);
      };
    } else {
      // Header exists — just show loading in content area, preserve search focus
      const contentEl = $("#library-content");
      if (contentEl) contentEl.innerHTML = '<div class="loading">Loading...</div>';
    }

    const url = query ? "/api/books?q=" + encodeURIComponent(query) : "/api/books";
    const resp = await api(url);
    if (!resp) return;
    const books = await resp.json();

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

    // Update only the content area — search input keeps focus
    const contentEl = $("#library-content");
    if (contentEl) {
      contentEl.innerHTML = content;
    }

    document.querySelectorAll(".card").forEach(c => {
      c.addEventListener("click", () => navigate("#/book/" + c.dataset.id));
    });
    document.querySelectorAll(".card img").forEach(img => {
      img.addEventListener("error", () => { img.style.background = "#333"; img.alt = "No cover"; });
    });
  }

  // ── Detail ────────────────────────────────────
  async function showDetail(id) {
    app().innerHTML = '<div class="loading">Loading...</div>';
    const resp = await api("/api/books/" + id);
    if (!resp) return;
    const book = await resp.json();

    const isEpub = book.format === "epub";
    const isPageBased = ["pdf", "cbz", "cbr"].includes(book.format);
    const readHash = isEpub ? `#/book/${id}/0/read` : (isPageBased ? `#/book/${id}/0/read` : "");

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

    const isEpub = book.format === "epub";

    if (isEpub) {
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
      // PDF / CBZ / CBR — page image viewer
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
    // Check if we have a valid session (cookie-based)
    const test = await fetch("/api/books", { credentials: "same-origin" });
    if (test.status === 401) { showLogin(); return; }
    authenticated = true;
    route();
  }

  init();
})();
