(function() {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const app = () => $("#app");

  let token = localStorage.getItem("folio_token") || "";

  function headers() {
    const h = { "Content-Type": "application/json" };
    if (token) h["Authorization"] = "Bearer " + token;
    return h;
  }

  async function api(path) {
    const resp = await fetch(path, { headers: headers() });
    if (resp.status === 401) { token = ""; localStorage.removeItem("folio_token"); showLogin(); return null; }
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
          body: JSON.stringify({ pin })
        });
        if (!resp.ok) { err.textContent = "Invalid PIN"; btn.disabled = false; return; }
        const data = await resp.json();
        token = data.token;
        localStorage.setItem("folio_token", token);
        route();
      } catch(e) { err.textContent = "Connection error"; btn.disabled = false; }
    }
    btn.onclick = doLogin;
    pinInput.onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
  }

  // ── Library ───────────────────────────────────
  async function showLibrary(query) {
    app().innerHTML = `
      <div class="header">
        <h1>Folio</h1>
        <input type="search" id="search" placeholder="Search books..." value="${query || ""}">
      </div>
      <div class="loading">Loading...</div>`;

    const url = query ? "/api/books?q=" + encodeURIComponent(query) : "/api/books";
    const resp = await api(url);
    if (!resp) return;
    const books = await resp.json();

    let content;
    if (books.length === 0) {
      content = '<div class="empty">No books found</div>';
    } else {
      content = '<div class="grid">' + books.map(b => `
        <div class="card" onclick="location.hash='#/book/${b.id}'">
          <img src="/api/books/${b.id}/cover" alt="" loading="lazy"
               onerror="this.style.background='#333';this.alt='No cover'">
          <div class="info">
            <div class="title">${esc(b.title)}</div>
            <div class="author">${esc(b.author)}</div>
            <div class="format">${b.format}</div>
          </div>
        </div>`).join("") + '</div>';
    }

    app().innerHTML = `
      <div class="header">
        <h1>Folio</h1>
        <input type="search" id="search" placeholder="Search books..." value="${esc(query || "")}">
      </div>
      ${content}`;

    let timer;
    $("#search").oninput = (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => showLibrary(e.target.value), 300);
    };
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
        <button class="back-btn" onclick="location.hash='#'">&larr;</button>
        <h1>${esc(book.title)}</h1>
      </div>
      <div class="detail">
        <div class="meta">
          <div class="cover">
            <img src="/api/books/${id}/cover" alt=""
                 onerror="this.style.background='#333'">
          </div>
          <div class="info">
            <h2>${esc(book.title)}</h2>
            <p>${esc(book.author)}</p>
            <p>Format: ${book.format.toUpperCase()}</p>
            ${book.description ? `<p>${esc(book.description)}</p>` : ""}
            <div class="actions">
              ${readHash ? `<button class="btn-primary" onclick="location.hash='${readHash}'">Read</button>` : ""}
              <a class="btn-secondary" href="/api/books/${id}/download">Download</a>
            </div>
          </div>
        </div>
      </div>`;
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
          <button class="back-btn" onclick="location.hash='#/book/${id}'">&larr;</button>
          <h1>${esc(book.title)}</h1>
        </div>
        <div class="reader">
          <div class="nav">
            <button ${index <= 0 ? "disabled" : ""} onclick="location.hash='#/book/${id}/${index-1}/read'">Prev</button>
            <span>Chapter ${index + 1} / ${total}</span>
            <button ${index >= total - 1 ? "disabled" : ""} onclick="location.hash='#/book/${id}/${index+1}/read'">Next</button>
          </div>
          <div class="content">${html}</div>
        </div>`;
    } else {
      // PDF / CBZ / CBR — page image viewer
      const countResp = await api(`/api/books/${id}/page-count`);
      if (!countResp) return;
      const { count } = await countResp.json();

      app().innerHTML = `
        <div class="header">
          <button class="back-btn" onclick="location.hash='#/book/${id}'">&larr;</button>
          <h1>${esc(book.title)}</h1>
        </div>
        <div class="reader">
          <div class="nav">
            <button ${index <= 0 ? "disabled" : ""} onclick="location.hash='#/book/${id}/${index-1}/read'">Prev</button>
            <span>Page ${index + 1} / ${count}</span>
            <button ${index >= count - 1 ? "disabled" : ""} onclick="location.hash='#/book/${id}/${index+1}/read'">Next</button>
          </div>
          <div class="page-img">
            <img src="/api/books/${id}/pages/${index}" alt="Page ${index + 1}">
          </div>
        </div>`;
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
    // Check if we need auth
    const resp = await fetch("/api/health");
    if (resp.status === 401) { showLogin(); return; }

    // Check if a token is needed (try accessing books)
    if (token) {
      const test = await fetch("/api/books", { headers: headers() });
      if (test.status === 401) { token = ""; localStorage.removeItem("folio_token"); showLogin(); return; }
    } else {
      const test = await fetch("/api/books");
      if (test.status === 401) { showLogin(); return; }
    }

    route();
  }

  init();
})();
