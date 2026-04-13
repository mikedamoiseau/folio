use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};

use super::WebState;
use crate::db;
use crate::models::BookFormat;

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
        .route("/series", get(list_series))
        .route("/collections", get(list_collections))
        .route("/collections/{id}/books", get(get_collection_books))
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

    // R2-2: Atomically check rate limit and record the attempt
    if !state.login_limiter.attempt(&client_ip) {
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
        return Err((StatusCode::UNAUTHORIZED, "Invalid PIN".into()));
    }

    // Successful login — clear rate limit entries for this IP
    state.login_limiter.clear(&client_ip);

    let token =
        super::auth::create_session(&state).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let cookie = format!("folio_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400");
    let body = Json(LoginResponse {
        token: token.clone(),
    });

    Ok(([(header::SET_COOKIE, cookie)], body).into_response())
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
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let books = db::list_books_grid(&conn)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
        Some("title") => books.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase())),
        Some("author") => {
            books.sort_by(|a, b| a.author.to_lowercase().cmp(&b.author.to_lowercase()))
        }
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
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let book = db::get_book(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;
    Ok(Json(book))
}

// ── Covers ───────────────────────────────────────────────────────────────────

async fn get_cover(
    State(state): State<WebState>,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let book = db::get_book(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    let cover_path = book
        .cover_path
        .ok_or_else(|| (StatusCode::NOT_FOUND, "No cover available".to_string()))?;

    let bytes = std::fs::read(&cover_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let book = db::get_book(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    if book.format != BookFormat::Epub {
        return Err((StatusCode::BAD_REQUEST, "Not an EPUB book".to_string()));
    }

    let toc = crate::epub::get_toc(&book.file_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::to_value(toc).unwrap_or_default()))
}

async fn get_chapter_content(
    State(state): State<WebState>,
    Path((id, index)): Path<(String, usize)>,
) -> Result<Response, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let book = db::get_book(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    if book.format != BookFormat::Epub {
        return Err((StatusCode::BAD_REQUEST, "Not an EPUB book".to_string()));
    }

    let data_dir = state.data_dir.to_string_lossy().to_string();
    let html = crate::epub::get_chapter_content(&book.file_path, index, &data_dir, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Rewrite asset:// URLs to HTTP URLs for web serving
    let html = rewrite_asset_urls_to_http(&html, &id, index);

    // R3-1: Sanitize HTML to prevent XSS from malicious EPUB content
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
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let book = db::get_book(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    match book.format {
        BookFormat::Pdf => {
            let (bytes, mime) = crate::pdf::get_page_image_bytes(&book.file_path, index)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
            Ok(([(header::CONTENT_TYPE, mime.to_string())], bytes).into_response())
        }
        BookFormat::Cbz => {
            let (bytes, mime) = crate::cbz::get_page_image_bytes(&book.file_path, index)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
            Ok(([(header::CONTENT_TYPE, mime)], bytes).into_response())
        }
        BookFormat::Cbr => {
            let (bytes, mime) = crate::cbr::get_page_image_bytes(&book.file_path, index)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
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
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let book = db::get_book(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    let count = match book.format {
        BookFormat::Pdf => crate::pdf::get_page_count(&book.file_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?,
        BookFormat::Cbz => crate::cbz::get_page_count(&book.file_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?,
        BookFormat::Cbr => crate::cbr::get_page_count(&book.file_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?,
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
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let book = db::get_book(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Book not found".to_string()))?;

    // R3-2: Stream the file instead of reading entirely into memory
    let file = tokio::fs::File::open(&book.file_path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let metadata = file
        .metadata()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let filename = std::path::Path::new(&book.file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("book");

    let mime = mime_guess::from_path(&book.file_path)
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

// ── Collections ──────────────────────────────────────────────────────────────

async fn list_series(
    State(state): State<WebState>,
) -> Result<Json<Vec<crate::models::SeriesInfo>>, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let series =
        db::list_series(&conn).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(series))
}

async fn list_collections(
    State(state): State<WebState>,
) -> Result<Json<Vec<crate::models::Collection>>, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let collections = db::list_collections(&conn)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(collections))
}

async fn get_collection_books(
    State(state): State<WebState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<crate::models::BookGridItem>>, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let books = db::get_books_in_collection_grid(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(books))
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
}
