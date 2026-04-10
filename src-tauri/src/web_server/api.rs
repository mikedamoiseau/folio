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
    State(state): State<WebState>,
    Json(body): Json<LoginRequest>,
) -> Result<Response, (StatusCode, String)> {
    let valid = state
        .pin_hash
        .lock()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()))?
        .as_ref()
        .map(|hash| super::auth::verify_pin(&body.pin, hash))
        .unwrap_or(false);

    if !valid {
        return Err((StatusCode::UNAUTHORIZED, "Invalid PIN".into()));
    }

    let token = super::auth::create_session(&state);
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
}

async fn list_books(
    State(state): State<WebState>,
    Query(params): Query<BookQuery>,
) -> Result<Json<Vec<crate::models::Book>>, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let books = db::list_books(&conn)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
            (
                header::CACHE_CONTROL,
                "public, max-age=86400".to_string(),
            ),
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

    Ok(([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response())
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
            (
                header::CACHE_CONTROL,
                "public, max-age=86400".to_string(),
            ),
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

    let bytes = std::fs::read(&book.file_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let filename = std::path::Path::new(&book.file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("book");

    let mime = mime_guess::from_path(&book.file_path)
        .first_or_octet_stream()
        .to_string();

    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

// ── Collections ──────────────────────────────────────────────────────────────

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
) -> Result<Json<Vec<crate::models::Book>>, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let books = db::get_books_in_collection(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(books))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rewrite_asset_urls() {
        let html =
            r#"<img src="asset://localhost/%2Ftmp%2Fimages%2Fbook1%2F0%2Fchapter1.jpg" />"#;
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
}
