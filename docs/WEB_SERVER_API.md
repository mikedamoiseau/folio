# Folio Web Server API

Folio embeds an HTTP server that lets you browse and read your library from any device on the local network.

## Getting Started

1. Open **Settings > Remote Access** in the desktop app
2. Set a PIN and click **Save PIN**
3. Click **Start Server**
4. Scan the QR code or type the URL on your phone/tablet

Default port: **7788** (configurable).

## Authentication

### PIN Login

```
POST /api/auth
Content-Type: application/json

{ "pin": "1234" }
```

Returns `{ "token": "uuid" }` and sets an `HttpOnly` cookie (`folio_session`).

Rate limited: 5 attempts per 5 minutes per IP. Returns `429 Too Many Requests` when exceeded.

### Session Cookie

After login, the `folio_session` cookie is sent automatically by browsers. Valid for 24 hours.

### HTTP Basic Auth (OPDS clients)

For OPDS reader apps (KOReader, Calibre, etc.) that don't support cookie-based auth:

```
Authorization: Basic base64(any_username:your_pin)
```

The username is ignored; only the password (PIN) is checked.

### No PIN Mode

If no PIN is configured, all endpoints are accessible without authentication.

---

## JSON API

### Books

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/books` | List books. Supports `?q=` search, `?series=` filter, `?sort=` (`date_added` \| `title` \| `author` \| `last_read` \| `rating`), and pagination via `?limit=&offset=` — the response carries an `X-Total-Count` header with the post-filter total. Omitting `limit` returns the full filtered/sorted list unchanged (backward-compatible). |
| GET | `/api/books/:id` | Get a single book by ID |
| GET | `/api/books/:id/cover` | Cover image (binary). Add `?size=thumb` for a downscaled thumbnail (falls back to the full cover if a thumbnail can't be generated). |
| GET | `/api/books/:id/download` | Download the original file |
| GET | `/api/books/continue-reading` | Most-recently-read, in-progress books for the home "Continue Reading" shelf. Supports `?limit=` (default 12, max 50). |
| GET | `/api/series` | List of series (name + book count) |

### EPUB Content

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/books/:id/chapters` | Table of contents |
| GET | `/api/books/:id/chapters/:index` | Chapter HTML (sanitized, images rewritten) |
| GET | `/api/books/:id/images/:chapter/:filename` | Inline EPUB image |

### PDF / CBZ / CBR Pages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/books/:id/pages/:index` | Page image (JPEG for PDF, original format for comics). Optional `?width=` (64–2048, clamped): PDF renders at that width; JPEG/PNG comic pages downscale to it (never upscale) and re-encode as JPEG. GIF and WebP pages are always served unchanged (resizing would drop animation frames), as are pages that fail to decode. Invalid or duplicate `width` values are ignored — PDFs then render at the server's default width (1200 px), comics return their original bytes. |
| GET | `/api/books/:id/page-count` | Returns `{ "count": N }` |

### Reading Progress

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/books/:id/progress` | Current reading progress for a book (`null` if none saved) |
| PUT | `/api/books/:id/progress` | Save reading progress. Body: `{ "chapter_index": N, "scroll_position": 0..1 }` (`chapter_index` doubles as the page index for PDF/CBZ/CBR) |
| GET | `/api/reading-progress` | All reading-progress rows, keyed by book ID — used to render progress badges on library grid cards |

### Collections

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/collections` | List all collections |
| GET | `/api/collections/:id/books` | Books in a collection |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check (always 200, no auth required) |

---

## OPDS Catalog

Compatible with KOReader, Calibre, Moon+ Reader, and other OPDS clients.

| Endpoint | Description |
|----------|-------------|
| GET `/opds` | Root navigation feed |
| GET `/opds/all` | All books (paginated, 50 per page, `?page=N`) |
| GET `/opds/new` | 25 most recently added books |
| GET `/opds/collections/:id` | Books in a collection |
| GET `/opds/search?q=term` | Search by title or author |

OPDS feeds use Atom XML. Pagination uses `rel="next"` links.

### OPDS Client Configuration

- **URL:** `http://<your-ip>:7788/opds`
- **Auth:** HTTP Basic (username: anything, password: your PIN)

---

## Web UI

Open `http://<your-ip>:7788/` in a browser for a built-in reading interface. It matches the desktop app's design (warm paper/terracotta palette, serif/sans type) and behavior:

- PIN login screen, light/dark/system theme toggle, and keyboard shortcuts (`/` to focus search, grid/reader navigation, a shortcuts overlay)
- Paginated, infinite-scroll book grid with server-side search, series/collection filters, and sort — fast even on large libraries
- Home shelves for "Continue Reading" and "Recently Added", with reading-progress badges on grid and shelf cards
- Book detail page with a progress bar and Continue / Start-over
- EPUB reader with chapter navigation (neighbouring chapters are prefetched in the background, so turning to the next chapter on a phone is instant); PDF/CBZ/CBR page-image reader with animated swipe page-turns on touch devices (reduced-motion aware)
- Reading progress syncs back to the library, so a book picks up where a desktop or other device session left off
- Installable as a PWA (web app manifest, service worker) and supports iOS "Add to Home Screen". The service worker only registers on a secure context (`https` or `localhost`), so offline shell caching does not activate over a plain-HTTP LAN URL — Add-to-Home-Screen and the manifest still work there
- Loading skeletons, friendly empty states, and broken-cover placeholders

All assets are embedded in the app (no CDN dependencies). The app shell can work offline once cached by the service worker; reading content and the API are never cached and always require a live connection to the server.

---

## Security

- PIN hashed with SHA-256, stored in OS keychain
- Session tokens: UUID v4, 24-hour TTL, HttpOnly + SameSite=Strict cookies
- Rate limiting: 5 failed login attempts per 5 min per IP
- CSP headers on all responses
- EPUB HTML sanitized with ammonia (no scripts, no event handlers)
- Path traversal protection on image endpoints
- File downloads streamed (no memory exhaustion)
- Server binds to `0.0.0.0` (all interfaces) for LAN access

## Tauri Commands

For the desktop frontend (React):

```typescript
invoke<string>("web_server_start", { port: 7788 })  // returns URL
invoke("web_server_stop")
invoke<WebServerStatus>("web_server_status")         // { running, url, port }
invoke("web_server_set_pin", { pin: "1234" })
invoke<string>("web_server_get_qr")                  // SVG string
```
