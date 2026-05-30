use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};

use super::auth::{log_login_attempt, LoginOutcome, WebAuthMethod};
use super::{folio_status, WebState};
use crate::db;
use crate::models::BookFormat;

/// Settings keys excluded from the GDPR export. Defense-in-depth: the web PIN
/// and backup credentials live in the OS keyring (not in settings), but two
/// settings DO carry sensitive data and are never exported:
/// - `backup_config`: remote endpoint details / pre-keyring secret values
/// - `enrichment_providers`: per-provider config including plaintext API keys
const EXPORT_SETTINGS_DENYLIST: &[&str] = &["backup_config", "enrichment_providers"];

/// Build the full GDPR export document: the shared core metadata plus the
/// activity log and a redacted settings map.
fn build_gdpr_export(
    conn: &rusqlite::Connection,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let mut value = db::build_core_export(conn).map_err(folio_status)?;

    let activity = db::get_activity_log(conn, 100_000, 0, None).map_err(folio_status)?;
    let activity_val = serde_json::to_value(activity).map_err(folio_status)?;

    let settings: serde_json::Map<String, serde_json::Value> = db::list_settings(conn)
        .map_err(folio_status)?
        .into_iter()
        .filter(|(k, _)| !EXPORT_SETTINGS_DENYLIST.contains(&k.as_str()))
        .map(|(k, v)| (k, serde_json::Value::String(v)))
        .collect();

    if let Some(obj) = value.as_object_mut() {
        obj.insert("activity_log".to_string(), activity_val);
        obj.insert("settings".to_string(), serde_json::Value::Object(settings));
    }
    Ok(value)
}

/// Current UTC date as `YYYYMMDD`, used for the export filenames.
fn export_datestamp() -> String {
    chrono::Utc::now().format("%Y%m%d").to_string()
}

/// Best-effort: record the export in the activity log. A failure is logged and
/// swallowed so it never fails the download (mirrors the login-audit pattern).
fn log_export_event(conn: &rusqlite::Connection) {
    use folio_core::activity::ActivityEvent;
    let f = ActivityEvent::LibraryExported {
        detail: "GDPR data export (web)".to_string(),
    }
    .into_fields();
    let entry = crate::models::ActivityEntry {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        action: f.action.to_string(),
        entity_type: f.entity_type.to_string(),
        entity_id: f.entity_id,
        entity_name: f.entity_name,
        detail: f.detail,
    };
    if let Err(e) = db::insert_activity(conn, &entry) {
        tracing::warn!(error = %e, "failed to log GDPR export to activity log");
    }
}

async fn data_export(State(state): State<WebState>) -> Result<Response, (StatusCode, String)> {
    use std::io::Write;

    let conn = state.conn().map_err(folio_status)?;
    let value = build_gdpr_export(&conn)?;
    let json = serde_json::to_string_pretty(&value).map_err(folio_status)?;

    let date = export_datestamp();
    let inner_name = format!("folio-export-{date}.json");
    let zip_name = format!("folio-export-{date}.zip");

    let buf = {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file(&inner_name, options).map_err(folio_status)?;
        zip.write_all(json.as_bytes()).map_err(folio_status)?;
        zip.finish().map_err(folio_status)?.into_inner()
    };

    log_export_event(&conn);

    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{zip_name}\""),
            ),
        ],
        buf,
    )
        .into_response())
}

/// Build all `/api/` routes.
pub fn routes(state: WebState) -> Router<WebState> {
    Router::new()
        .route("/health", get(health))
        .route("/auth", axum::routing::post(login))
        .route("/books", get(list_books))
        .route("/books/{id}", get(get_book))
        .route("/books/{id}/cover", get(get_cover))
        .route("/books/{id}/chapters", get(get_chapters))
        .route("/books/{id}/chapters/{index}", get(get_chapter_content))
        .route(
            "/books/{id}/images/{chapter}/{filename}",
            get(get_epub_image),
        )
        .route("/books/{id}/pages/{index}", get(get_page_image))
        .route("/books/{id}/page-count", get(get_page_count))
        .route("/books/{id}/download", get(download_book))
        // OPDS feeds emit `/download/{book_id}.{ext}` so clients using URL-
        // based extension detection can disambiguate AZW vs AZW3 (both share
        // the `application/vnd.amazon.ebook` MIME). The filename segment is
        // ignored server-side — the same handler serves the stored file.
        .route(
            "/books/{id}/download/{filename}",
            get(download_book_with_filename),
        )
        .route("/stats", get(get_stats))
        .route("/series", get(list_series))
        .route("/collections", get(list_collections))
        .route("/collections/{id}/books", get(get_collection_books))
        .route("/audit/login-history", get(login_history))
        .route("/data-export", get(data_export))
        .with_state(state)
}

// ── Health + Auth ────────────────────────────────────────────────────────────

async fn health() -> &'static str {
    "ok"
}

#[derive(serde::Deserialize)]
struct LoginRequest {
    pin: String,
}

#[derive(serde::Serialize)]
struct LoginResponse {
    token: String,
}

async fn login(
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    State(state): State<WebState>,
    req: axum::extract::Request,
) -> Result<Response, (StatusCode, String)> {
    // Use the actual peer IP from the TCP connection (not spoofable headers)
    let client_ip = addr.ip().to_string();

    // Capture the user-agent before the request body is consumed below.
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // R2-2: Atomically check rate limit and record the attempt
    if !state.login_limiter.attempt(&client_ip) {
        if let Ok(conn) = state.conn() {
            log_login_attempt(
                &conn,
                &client_ip,
                user_agent.as_deref(),
                WebAuthMethod::Session,
                LoginOutcome::RateLimited,
            );
        }
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Too many login attempts. Try again later.".to_string(),
        ));
    }

    let body: LoginRequest = {
        let bytes = axum::body::to_bytes(req.into_body(), 1024)
            .await
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid request body".to_string()))?;
        serde_json::from_slice(&bytes)
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid JSON".to_string()))?
    };

    let valid = state
        .pin_hash
        .lock()
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error".to_string(),
            )
        })?
        .as_ref()
        .map(|hash| super::auth::verify_pin(&body.pin, hash))
        .unwrap_or(false);

    if !valid {
        if let Ok(conn) = state.conn() {
            log_login_attempt(
                &conn,
                &client_ip,
                user_agent.as_deref(),
                WebAuthMethod::Session,
                LoginOutcome::InvalidPin,
            );
        }
        return Err((StatusCode::UNAUTHORIZED, "Invalid PIN".into()));
    }

    // Successful login — clear rate limit entries for this IP
    state.login_limiter.clear(&client_ip);

    let token = super::auth::create_session(&state).map_err(folio_status)?;

    // Log success only after the session token was actually created.
    if let Ok(conn) = state.conn() {
        log_login_attempt(
            &conn,
            &client_ip,
            user_agent.as_deref(),
            WebAuthMethod::Session,
            LoginOutcome::Success,
        );
    }

    let cookie = format!("folio_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400");
    let body = Json(LoginResponse {
        token: token.clone(),
    });

    Ok(([(header::SET_COOKIE, cookie)], body).into_response())
}

#[derive(serde::Deserialize)]
struct HistoryQuery {
    limit: Option<u32>,
}

async fn login_history(
    State(state): State<WebState>,
    Query(params): Query<HistoryQuery>,
) -> Result<Json<Vec<crate::models::WebSessionEntry>>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let rows = db::get_web_session_log(&conn, params.limit.unwrap_or(100).min(1000))
        .map_err(folio_status)?;
    Ok(Json(rows))
}

// ── Books ────────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct BookQuery {
    q: Option<String>,
    series: Option<String>,
    sort: Option<String>, // title, author, last_read, rating (default: date_added)
}

async fn list_books(
    State(state): State<WebState>,
    Query(params): Query<BookQuery>,
) -> Result<Json<Vec<crate::models::BookGridItem>>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let books = db::list_books_grid(&conn).map_err(folio_status)?;

    let books = match params.series {
        Some(ref s) if !s.is_empty() => books
            .into_iter()
            .filter(|b| b.series.as_deref() == Some(s.as_str()))
            .collect(),
        _ => books,
    };

    let books = match params.q {
        Some(ref q) if !q.is_empty() => {
            let q_lower = q.to_lowercase();
            books
                .into_iter()
                .filter(|b| {
                    b.title.to_lowercase().contains(&q_lower)
                        || b.author.to_lowercase().contains(&q_lower)
                })
                .collect()
        }
        _ => books,
    };

    // Sort
    let mut books = books;
    match params.sort.as_deref() {
        Some("title") => books.sort_by_key(|a| a.title.to_lowercase()),
        Some("author") => books.sort_by_key(|a| a.author.to_lowercase()),
        Some("rating") => books.sort_by(|a, b| {
            b.rating
                .unwrap_or(0.0)
                .partial_cmp(&a.rating.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        Some("last_read") => {
            // Need reading progress for last_read sort
            let progress_map: std::collections::HashMap<String, i64> =
                db::get_all_reading_progress(&conn)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| (p.book_id, p.last_read_at))
                    .collect();
            books.sort_by(|a, b| {
                let la = progress_map.get(&a.id).copied().unwrap_or(0);
                let lb = progress_map.get(&b.id).copied().unwrap_or(0);
                lb.cmp(&la)
            });
        }
        _ => {} // default: date_added DESC from SQL
    }

    Ok(Json(books))
}

async fn get_book(
    State(state): State<WebState>,
    Path(id): Path<String>,
) -> Result<Json<crate::models::Book>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let book = db::get_book(&conn, &id)
        .map_err(folio_status)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;
    Ok(Json(book))
}

// ── Covers ───────────────────────────────────────────────────────────────────

async fn get_cover(
    State(state): State<WebState>,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let book = db::get_book(&conn, &id)
        .map_err(folio_status)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    let cover_path = book
        .cover_path
        .ok_or_else(|| (StatusCode::NOT_FOUND, "No cover available".to_string()))?;

    let bytes = std::fs::read(&cover_path).map_err(folio_status)?;

    let mime = mime_guess::from_path(&cover_path)
        .first_or_octet_stream()
        .to_string();

    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "public, max-age=86400".to_string()),
        ],
        bytes,
    )
        .into_response())
}

// ── EPUB Chapters ────────────────────────────────────────────────────────────

async fn get_chapters(
    State(state): State<WebState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let book = db::get_book(&conn, &id)
        .map_err(folio_status)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    let file_path = state.resolve_book_path(&book).map_err(folio_status)?;
    let toc = match book.format {
        BookFormat::Epub => crate::epub::get_toc(&file_path).map_err(folio_status)?,
        #[cfg(feature = "mobi")]
        BookFormat::Mobi => {
            // MOBI has no real TOC — mirror the desktop `get_toc` behaviour by
            // synthesising a flat list from the chapter list.
            let chapters = folio_core::mobi::get_chapter_list(&file_path).map_err(folio_status)?;
            chapters
                .into_iter()
                .map(|c| crate::models::TocEntry {
                    chapter_index: c.index as u32,
                    label: c.title,
                    play_order: format!("{}", c.index + 1),
                    children: Vec::new(),
                })
                .collect()
        }
        #[cfg(not(feature = "mobi"))]
        BookFormat::Mobi => {
            return Err((
                StatusCode::BAD_REQUEST,
                "MOBI support is not enabled in this build".to_string(),
            ));
        }
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "TOC is only available for EPUB and MOBI books".to_string(),
            ));
        }
    };

    Ok(Json(serde_json::to_value(toc).unwrap_or_default()))
}

async fn get_chapter_content(
    State(state): State<WebState>,
    Path((id, index)): Path<(String, usize)>,
) -> Result<Response, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let book = db::get_book(&conn, &id)
        .map_err(folio_status)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    let file_path = state.resolve_book_path(&book).map_err(folio_status)?;
    let images_storage = state.images_storage().map_err(folio_status)?;

    let html = match book.format {
        BookFormat::Epub => {
            crate::epub::get_chapter_content(&file_path, index, images_storage.as_ref(), &id)
                .map_err(folio_status)?
        }
        #[cfg(feature = "mobi")]
        BookFormat::Mobi => {
            folio_core::mobi::get_chapter_content(&file_path, index, images_storage.as_ref(), &id)
                .map_err(folio_status)?
        }
        #[cfg(not(feature = "mobi"))]
        BookFormat::Mobi => {
            return Err((
                StatusCode::BAD_REQUEST,
                "MOBI support is not enabled in this build".to_string(),
            ));
        }
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "Chapter content is only available for EPUB and MOBI books".to_string(),
            ));
        }
    };

    // Rewrite asset:// URLs to HTTP URLs for web serving
    let html = rewrite_asset_urls_to_http(&html, &id, index);

    // R3-1: Sanitize HTML to prevent XSS from malicious book content
    let html = sanitize_chapter_html(&html);

    Ok(([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response())
}

/// Validate that a filename is safe (no path traversal sequences).
fn is_safe_filename(name: &str) -> bool {
    let decoded = urlencoding::decode(name).unwrap_or_default();
    let decoded = decoded.as_ref();
    !decoded.contains("..")
        && !decoded.starts_with('/')
        && !decoded.starts_with('\\')
        && !decoded.contains('\0')
}

/// Sanitize chapter HTML for web serving — strip scripts and event handlers.
fn sanitize_chapter_html(html: &str) -> String {
    ammonia::Builder::new()
        .add_tags([
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "p",
            "div",
            "span",
            "a",
            "em",
            "strong",
            "b",
            "i",
            "u",
            "s",
            "sub",
            "sup",
            "br",
            "hr",
            "img",
            "figure",
            "figcaption",
            "ul",
            "ol",
            "li",
            "dl",
            "dt",
            "dd",
            "table",
            "thead",
            "tbody",
            "tr",
            "th",
            "td",
            "blockquote",
            "pre",
            "code",
            "section",
            "article",
            "nav",
            "header",
            "footer",
            "aside",
            "details",
            "summary",
        ])
        .add_tag_attributes("a", &["href", "title"])
        .add_tag_attributes("img", &["src", "alt", "width", "height"])
        .add_tag_attributes("td", &["colspan", "rowspan"])
        .add_tag_attributes("th", &["colspan", "rowspan"])
        .url_relative(ammonia::UrlRelative::PassThrough)
        .clean(html)
        .to_string()
}

/// Rewrite `asset://localhost/...` image URLs to HTTP `/api/books/{id}/images/{chapter}/{filename}`.
fn rewrite_asset_urls_to_http(html: &str, book_id: &str, chapter_index: usize) -> String {
    // The epub module produces URLs like: asset://localhost/{url_encoded_path}
    // We need to extract the filename and rewrite to our HTTP route.
    let mut result = html.to_string();

    while let Some(start) = result.find("asset://localhost/") {
        let rest = &result[start + 18..]; // skip "asset://localhost/"
        let url_end = rest
            .find('"')
            .or_else(|| rest.find('\''))
            .or_else(|| rest.find(')'))
            .unwrap_or(rest.len());

        let encoded_path = &rest[..url_end];
        let decoded = urlencoding::decode(encoded_path).unwrap_or_default();
        let filename = decoded.rsplit('/').next().unwrap_or("image");

        let new_url = format!("/api/books/{book_id}/images/{chapter_index}/{filename}");
        result = format!(
            "{}{}{}",
            &result[..start],
            new_url,
            &result[start + 18 + url_end..]
        );
    }

    result
}

async fn get_epub_image(
    State(state): State<WebState>,
    Path((id, chapter, filename)): Path<(String, usize, String)>,
) -> Result<Response, (StatusCode, String)> {
    // R2-1: Prevent path traversal
    if !is_safe_filename(&filename) {
        return Err((StatusCode::BAD_REQUEST, "Invalid filename".to_string()));
    }

    let image_path = state
        .data_dir
        .join("images")
        .join(&id)
        .join(chapter.to_string())
        .join(&filename);

    let bytes = std::fs::read(&image_path).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            format!("Image not found: {filename}"),
        )
    })?;

    let mime = mime_guess::from_path(&filename)
        .first_or_octet_stream()
        .to_string();

    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "public, max-age=86400".to_string()),
        ],
        bytes,
    )
        .into_response())
}

// ── PDF / Comic Pages ────────────────────────────────────────────────────────

async fn get_page_image(
    State(state): State<WebState>,
    Path((id, index)): Path<(String, u32)>,
) -> Result<Response, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let book = db::get_book(&conn, &id)
        .map_err(folio_status)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    let file_path = state.resolve_book_path(&book).map_err(folio_status)?;

    match book.format {
        BookFormat::Pdf => {
            let (bytes, mime) =
                crate::pdf::get_page_image_bytes(&file_path, index, None).map_err(folio_status)?;
            Ok(([(header::CONTENT_TYPE, mime.to_string())], bytes).into_response())
        }
        BookFormat::Cbz => {
            let (bytes, mime) =
                crate::cbz::get_page_image_bytes(&file_path, index, None).map_err(folio_status)?;
            Ok(([(header::CONTENT_TYPE, mime)], bytes).into_response())
        }
        BookFormat::Cbr => {
            let (bytes, mime) =
                crate::cbr::get_page_image_bytes(&file_path, index, None).map_err(folio_status)?;
            Ok(([(header::CONTENT_TYPE, mime)], bytes).into_response())
        }
        _ => Err((
            StatusCode::BAD_REQUEST,
            "Page images only available for PDF/CBZ/CBR".to_string(),
        )),
    }
}

async fn get_page_count(
    State(state): State<WebState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let book = db::get_book(&conn, &id)
        .map_err(folio_status)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    let file_path = state.resolve_book_path(&book).map_err(folio_status)?;

    let count = match book.format {
        BookFormat::Pdf => crate::pdf::get_page_count(&file_path).map_err(folio_status)?,
        BookFormat::Cbz => crate::cbz::get_page_count(&file_path).map_err(folio_status)?,
        BookFormat::Cbr => crate::cbr::get_page_count(&file_path).map_err(folio_status)?,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "Page count only available for PDF/CBZ/CBR".to_string(),
            ))
        }
    };

    Ok(Json(serde_json::json!({ "count": count })))
}

// ── Download ─────────────────────────────────────────────────────────────────

async fn download_book(
    State(state): State<WebState>,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let book = db::get_book(&conn, &id)
        .map_err(folio_status)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    let file_path = state.resolve_book_path(&book).map_err(folio_status)?;

    // R3-2: Stream the file instead of reading entirely into memory
    let file = tokio::fs::File::open(&file_path)
        .await
        .map_err(folio_status)?;

    let metadata = file.metadata().await.map_err(folio_status)?;

    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("book");

    let mime = mime_guess::from_path(&file_path)
        .first_or_octet_stream()
        .to_string();

    let stream = tokio_util::io::ReaderStream::new(file);
    let body = axum::body::Body::from_stream(stream);

    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
            (header::CONTENT_LENGTH, metadata.len().to_string()),
        ],
        body,
    )
        .into_response())
}

/// Same as [`download_book`] but with a trailing filename segment that is
/// discarded. The OPDS feed emits URLs of the form `/download/{id}.{ext}`
/// so OPDS clients can key off the URL extension when the MIME is ambiguous
/// (e.g. AZW vs AZW3 both use `application/vnd.amazon.ebook`).
async fn download_book_with_filename(
    state: State<WebState>,
    Path((id, _filename)): Path<(String, String)>,
) -> Result<Response, (StatusCode, String)> {
    download_book(state, Path(id)).await
}

// ── Collections ──────────────────────────────────────────────────────────────

async fn list_series(
    State(state): State<WebState>,
) -> Result<Json<Vec<crate::models::SeriesInfo>>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let series = db::list_series(&conn).map_err(folio_status)?;
    Ok(Json(series))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectionWithCount {
    id: String,
    name: String,
    r#type: crate::models::CollectionType,
    icon: Option<String>,
    color: Option<String>,
    created_at: i64,
    updated_at: i64,
    rules: Vec<crate::models::CollectionRule>,
    book_count: usize,
}

async fn list_collections(
    State(state): State<WebState>,
) -> Result<Json<Vec<CollectionWithCount>>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let collections = db::list_collections(&conn).map_err(folio_status)?;

    let result: Vec<CollectionWithCount> = collections
        .into_iter()
        .map(|c| {
            let book_count = db::get_books_in_collection_grid(&conn, &c.id)
                .map(|books| books.len())
                .unwrap_or(0);
            CollectionWithCount {
                id: c.id,
                name: c.name,
                r#type: c.r#type,
                icon: c.icon,
                color: c.color,
                created_at: c.created_at,
                updated_at: c.updated_at,
                rules: c.rules,
                book_count,
            }
        })
        .collect();

    Ok(Json(result))
}

async fn get_collection_books(
    State(state): State<WebState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<crate::models::BookGridItem>>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let books = db::get_books_in_collection_grid(&conn, &id).map_err(folio_status)?;
    Ok(Json(books))
}

// ── Stats ───────────────────────────────────────────────────────────────────

async fn get_stats(
    State(state): State<WebState>,
) -> Result<Json<db::ReadingStats>, (StatusCode, String)> {
    let conn = state.conn().map_err(folio_status)?;
    let stats = db::get_reading_stats(&conn).map_err(folio_status)?;
    Ok(Json(stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rewrite_asset_urls() {
        let html = r#"<img src="asset://localhost/%2Ftmp%2Fimages%2Fbook1%2F0%2Fchapter1.jpg" />"#;
        let result = rewrite_asset_urls_to_http(html, "book1", 0);
        assert!(result.contains("/api/books/book1/images/0/chapter1.jpg"));
        assert!(!result.contains("asset://"));
    }

    #[test]
    fn test_rewrite_asset_urls_no_assets() {
        let html = "<p>Hello world</p>";
        let result = rewrite_asset_urls_to_http(html, "book1", 0);
        assert_eq!(result, html);
    }

    // R2-1: Path traversal prevention
    #[test]
    fn test_validate_image_filename_rejects_traversal() {
        assert!(!is_safe_filename("../../../etc/passwd"));
        assert!(!is_safe_filename("..%2F..%2Fetc/passwd"));
        assert!(!is_safe_filename("foo/../bar"));
        assert!(!is_safe_filename(".."));
        assert!(!is_safe_filename("/absolute/path"));
    }

    #[test]
    fn test_validate_image_filename_accepts_valid() {
        assert!(is_safe_filename("image.jpg"));
        assert!(is_safe_filename("chapter1-cover.png"));
        assert!(is_safe_filename("my image (1).webp"));
    }

    // R3-1: XSS sanitization
    #[test]
    fn test_sanitize_chapter_html_strips_scripts() {
        let html = r#"<p>Hello</p><script>alert('xss')</script><p>World</p>"#;
        let sanitized = sanitize_chapter_html(html);
        assert!(!sanitized.contains("<script>"));
        assert!(!sanitized.contains("alert("));
        assert!(sanitized.contains("Hello"));
        assert!(sanitized.contains("World"));
    }

    #[test]
    fn test_sanitize_chapter_html_strips_event_handlers() {
        let html = r#"<img src="x" onerror="alert('xss')">"#;
        let sanitized = sanitize_chapter_html(html);
        assert!(!sanitized.contains("onerror"));
        assert!(!sanitized.contains("alert"));
    }

    #[test]
    fn test_sanitize_chapter_html_preserves_safe_content() {
        let html = r#"<h1>Title</h1><p>Text with <em>emphasis</em> and <a href="/link">a link</a>.</p><img src="/api/books/1/images/0/fig.jpg">"#;
        let sanitized = sanitize_chapter_html(html);
        assert!(sanitized.contains("<h1>"));
        assert!(sanitized.contains("<em>"));
        assert!(sanitized.contains("<img"));
    }

    // R2-4: URL rewriting with regex handles multiple URLs
    #[test]
    fn test_rewrite_asset_urls_multiple_images() {
        let html = r#"<img src="asset://localhost/a/b/c/img1.jpg"><img src="asset://localhost/x/y/z/img2.png">"#;
        let result = rewrite_asset_urls_to_http(html, "book1", 3);
        assert!(result.contains("/api/books/book1/images/3/img1.jpg"));
        assert!(result.contains("/api/books/book1/images/3/img2.png"));
        assert!(!result.contains("asset://"));
    }

    // R2-4: URL rewriting handles UTF-8 filenames
    #[test]
    fn test_rewrite_asset_urls_utf8_filename() {
        let html = r#"<img src="asset://localhost/path/%E5%9B%BE%E7%89%87.jpg">"#;
        let result = rewrite_asset_urls_to_http(html, "book1", 0);
        assert!(!result.contains("asset://"));
    }

    #[test]
    fn test_book_query_accepts_series_param() {
        let query: BookQuery =
            serde_json::from_str(r#"{"series":"My Series"}"#).expect("should parse series param");
        assert_eq!(query.series, Some("My Series".to_string()));
        assert_eq!(query.q, None);
    }

    #[test]
    fn test_book_query_accepts_both_params() {
        let query: BookQuery =
            serde_json::from_str(r#"{"q":"test","series":"Sci-Fi"}"#).expect("should parse both");
        assert_eq!(query.q, Some("test".to_string()));
        assert_eq!(query.series, Some("Sci-Fi".to_string()));
    }

    #[test]
    fn test_book_query_empty() {
        let query: BookQuery = serde_json::from_str("{}").expect("should parse empty");
        assert_eq!(query.q, None);
        assert_eq!(query.series, None);
    }

    #[test]
    fn test_collection_with_count_serializes() {
        let coll = CollectionWithCount {
            id: "c1".into(),
            name: "Test".into(),
            r#type: crate::models::CollectionType::Manual,
            icon: Some("\u{1F4DA}".into()),
            color: None,
            created_at: 0,
            updated_at: 0,
            rules: vec![],
            book_count: 5,
        };
        let json = serde_json::to_value(&coll).unwrap();
        assert_eq!(json["bookCount"], 5);
        assert_eq!(json["name"], "Test");
        assert_eq!(json["icon"], "\u{1F4DA}");
    }

    #[test]
    fn gdpr_export_redacts_backup_config() {
        // `run_schema` is private to folio-core; build a schema-migrated
        // in-memory connection through the pool helper (same as `test_state`).
        let pool = crate::db::create_pool(&std::path::PathBuf::from(":memory:")).unwrap();
        let conn = pool.get().unwrap();
        db::set_setting(&conn, "backup_config", "{\"secret\":\"x\"}").unwrap();
        db::set_setting(
            &conn,
            "enrichment_providers",
            "{\"google\":{\"enabled\":true,\"apiKey\":\"SECRET\"}}",
        )
        .unwrap();
        db::set_setting(&conn, "import_mode", "copy").unwrap();

        let value = build_gdpr_export(&conn).expect("build_gdpr_export");
        let settings = value["settings"].as_object().expect("settings object");
        assert!(
            !settings.contains_key("backup_config"),
            "backup_config must be redacted"
        );
        assert!(
            !settings.contains_key("enrichment_providers"),
            "enrichment_providers (carries API keys) must be redacted"
        );
        assert_eq!(settings["import_mode"], "copy");
        assert!(value["activity_log"].is_array());

        let serialized = serde_json::to_string(&value).unwrap();
        assert!(!serialized.contains("SECRET"), "API key leaked into export");
    }

    #[test]
    fn test_stats_endpoint_exists() {
        let stats = db::ReadingStats {
            total_reading_time_secs: 3600,
            total_sessions: 10,
            total_pages_read: 200,
            books_finished: 2,
            current_streak_days: 3,
            longest_streak_days: 7,
            daily_reading: vec![("2026-05-01".to_string(), 1800)],
        };
        let json = serde_json::to_value(&stats).unwrap();
        assert_eq!(json["totalReadingTimeSecs"], 3600);
        assert_eq!(json["totalSessions"], 10);
        assert_eq!(json["totalPagesRead"], 200);
        assert_eq!(json["booksFinished"], 2);
        assert_eq!(json["currentStreakDays"], 3);
        assert_eq!(json["longestStreakDays"], 7);
        assert!(json["dailyReading"].is_array());
    }
}
