use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

use super::WebState;
use crate::db;
use crate::models::Book;

const ATOM_CONTENT_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=navigation";
const ATOM_ACQ_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=acquisition";

/// Build all `/opds/` routes.
pub fn routes(state: WebState) -> Router<WebState> {
    Router::new()
        .route("/", get(root_catalog))
        .route("/all", get(all_books))
        .route("/new", get(new_books))
        .route("/collections/{id}", get(collection_feed))
        .route("/search", get(search_books))
        .with_state(state)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn book_to_entry(book: &Book) -> String {
    let title = xml_escape(&book.title);
    let author = xml_escape(&book.author);
    let id = &book.id;
    let updated = chrono::DateTime::from_timestamp(book.added_at, 0)
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|| "2024-01-01T00:00:00Z".to_string());

    let description = book
        .description
        .as_ref()
        .map(|d| format!("<summary>{}</summary>", xml_escape(d)))
        .unwrap_or_default();

    let cover_link = format!(
        r#"<link rel="http://opds-spec.org/image" href="/api/books/{id}/cover" type="image/jpeg"/>"#
    );

    let ext = match book.format {
        crate::models::BookFormat::Epub => "epub",
        crate::models::BookFormat::Pdf => "pdf",
        crate::models::BookFormat::Cbz => "cbz",
        crate::models::BookFormat::Cbr => "cbr",
    };
    let mime = match book.format {
        crate::models::BookFormat::Epub => "application/epub+zip",
        crate::models::BookFormat::Pdf => "application/pdf",
        crate::models::BookFormat::Cbz => "application/x-cbz",
        crate::models::BookFormat::Cbr => "application/x-cbr",
    };
    let download_link = format!(
        r#"<link rel="http://opds-spec.org/acquisition" href="/api/books/{id}/download" type="{mime}" title="{title}.{ext}"/>"#
    );

    format!(
        r#"<entry>
  <title>{title}</title>
  <id>urn:folio:{id}</id>
  <updated>{updated}</updated>
  <author><name>{author}</name></author>
  {description}
  {cover_link}
  {download_link}
</entry>"#
    )
}

fn wrap_feed(title: &str, feed_id: &str, entries: &str, self_href: &str, kind: &str) -> String {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>{feed_id}</id>
  <title>{title}</title>
  <updated>{now}</updated>
  <link rel="self" href="{self_href}" type="{kind}"/>
  <link rel="start" href="/opds" type="{ATOM_CONTENT_TYPE}"/>
  <link rel="search" href="/opds/search?q={{searchTerms}}" type="{ATOM_ACQ_TYPE}"/>
{entries}
</feed>"#
    )
}

async fn root_catalog() -> Response {
    let entries = format!(
        r#"<entry>
  <title>All Books</title>
  <id>urn:folio:all</id>
  <updated>{now}</updated>
  <content type="text">Browse the entire library</content>
  <link rel="subsection" href="/opds/all" type="{ATOM_ACQ_TYPE}"/>
</entry>
<entry>
  <title>Recently Added</title>
  <id>urn:folio:new</id>
  <updated>{now}</updated>
  <content type="text">Books added recently</content>
  <link rel="subsection" href="/opds/new" type="{ATOM_ACQ_TYPE}"/>
</entry>"#,
        now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"),
    );

    let xml = wrap_feed(
        "Folio Library",
        "urn:folio:root",
        &entries,
        "/opds",
        ATOM_CONTENT_TYPE,
    );

    ([(header::CONTENT_TYPE, ATOM_CONTENT_TYPE)], xml).into_response()
}

async fn all_books(State(state): State<WebState>) -> Result<Response, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let books =
        db::list_books(&conn).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let entries: String = books
        .iter()
        .map(book_to_entry)
        .collect::<Vec<_>>()
        .join("\n");

    let xml = wrap_feed(
        "All Books",
        "urn:folio:all",
        &entries,
        "/opds/all",
        ATOM_ACQ_TYPE,
    );

    Ok(([(header::CONTENT_TYPE, ATOM_ACQ_TYPE)], xml).into_response())
}

async fn new_books(State(state): State<WebState>) -> Result<Response, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let mut books =
        db::list_books(&conn).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Sort by added_at descending, take 25 most recent
    books.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    books.truncate(25);

    let entries: String = books
        .iter()
        .map(book_to_entry)
        .collect::<Vec<_>>()
        .join("\n");

    let xml = wrap_feed(
        "Recently Added",
        "urn:folio:new",
        &entries,
        "/opds/new",
        ATOM_ACQ_TYPE,
    );

    Ok(([(header::CONTENT_TYPE, ATOM_ACQ_TYPE)], xml).into_response())
}

async fn collection_feed(
    State(state): State<WebState>,
    Path(id): Path<String>,
) -> Result<Response, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let books = db::get_books_in_collection(&conn, &id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let entries: String = books
        .iter()
        .map(book_to_entry)
        .collect::<Vec<_>>()
        .join("\n");

    let xml = wrap_feed(
        &format!("Collection {id}"),
        &format!("urn:folio:collection:{id}"),
        &entries,
        &format!("/opds/collections/{id}"),
        ATOM_ACQ_TYPE,
    );

    Ok(([(header::CONTENT_TYPE, ATOM_ACQ_TYPE)], xml).into_response())
}

#[derive(serde::Deserialize)]
struct SearchQuery {
    q: Option<String>,
}

async fn search_books(
    State(state): State<WebState>,
    Query(params): Query<SearchQuery>,
) -> Result<Response, (StatusCode, String)> {
    let conn = state
        .conn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let books =
        db::list_books(&conn).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let filtered: Vec<Book> = match params.q {
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

    let entries: String = filtered
        .iter()
        .map(book_to_entry)
        .collect::<Vec<_>>()
        .join("\n");

    let search_term = params.q.as_deref().unwrap_or("");
    let xml = wrap_feed(
        &format!("Search: {}", xml_escape(search_term)),
        "urn:folio:search",
        &entries,
        &format!("/opds/search?q={}", urlencoding::encode(search_term)),
        ATOM_ACQ_TYPE,
    );

    Ok(([(header::CONTENT_TYPE, ATOM_ACQ_TYPE)], xml).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xml_escape() {
        assert_eq!(xml_escape("foo & bar"), "foo &amp; bar");
        assert_eq!(xml_escape("<script>"), "&lt;script&gt;");
        assert_eq!(xml_escape("\"quoted\""), "&quot;quoted&quot;");
    }

    #[test]
    fn test_book_to_entry_contains_required_elements() {
        let book = Book {
            id: "test-1".to_string(),
            title: "Test & Book".to_string(),
            author: "Author <Name>".to_string(),
            file_path: "/tmp/test.epub".to_string(),
            cover_path: None,
            total_chapters: 5,
            added_at: 1700000000,
            format: crate::models::BookFormat::Epub,
            file_hash: None,
            description: Some("A <great> book".to_string()),
            genres: None,
            rating: None,
            isbn: None,
            openlibrary_key: None,
            enrichment_status: None,
            series: None,
            volume: None,
            language: None,
            publisher: None,
            publish_year: None,
            is_imported: true,
        };

        let entry = book_to_entry(&book);
        assert!(entry.contains("<title>Test &amp; Book</title>"));
        assert!(entry.contains("Author &lt;Name&gt;"));
        assert!(entry.contains("urn:folio:test-1"));
        assert!(entry.contains("application/epub+zip"));
        assert!(entry.contains("/api/books/test-1/download"));
        assert!(entry.contains("A &lt;great&gt; book"));
    }
}
