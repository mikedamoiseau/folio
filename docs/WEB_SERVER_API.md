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
| GET | `/api/books` | List all books. Supports `?q=` search filter. |
| GET | `/api/books/:id` | Get a single book by ID |
| GET | `/api/books/:id/cover` | Cover image (binary) |
| GET | `/api/books/:id/download` | Download the original file |

### EPUB Content

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/books/:id/chapters` | Table of contents |
| GET | `/api/books/:id/chapters/:index` | Chapter HTML (sanitized, images rewritten) |
| GET | `/api/books/:id/images/:chapter/:filename` | Inline EPUB image |

### PDF / CBZ / CBR Pages

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/books/:id/pages/:index` | Page image (JPEG for PDF, original format for comics) |
| GET | `/api/books/:id/page-count` | Returns `{ "count": N }` |

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

Open `http://<your-ip>:7788/` in a browser for a built-in reading interface.

- PIN login screen
- Responsive book grid with covers and search
- Book detail with Read/Download buttons
- EPUB reader with chapter navigation
- PDF/comic page viewer with prev/next

All assets are embedded in the app (no CDN dependencies). Works fully offline on LAN.

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
