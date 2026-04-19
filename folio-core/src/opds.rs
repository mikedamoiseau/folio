use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::error::{FolioError, FolioResult};

/// Maximum time to wait for an OPDS HTTP response.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Maximum response body size (5 MB) to prevent DoS via large feeds.
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;

/// Validate that a URL is safe to fetch (no file://, no private IPs).
fn is_safe_url(url: &str) -> bool {
    // Only allow http:// and https:// schemes
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return false;
    }
    // Extract host portion
    let after_scheme = if let Some(s) = url.strip_prefix("https://") {
        s
    } else if let Some(s) = url.strip_prefix("http://") {
        s
    } else {
        return false;
    };
    let host = after_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");

    // Block loopback and private network ranges
    if host == "localhost" || host.ends_with(".localhost") {
        return false;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                if v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_unspecified()
                    || v4.octets()[0] == 169 && v4.octets()[1] == 254
                // link-local
                {
                    return false;
                }
            }
            std::net::IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_unspecified() {
                    return false;
                }
            }
        }
    }
    true
}

/// A single entry from an OPDS feed (book or navigation link).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsEntry {
    pub id: String,
    pub title: String,
    pub author: String,
    pub summary: String,
    pub cover_url: Option<String>,
    /// Download links: Vec<(href, type, rel)>
    pub links: Vec<OpdsLink>,
    /// Navigation links (for sub-catalogs)
    pub nav_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsLink {
    pub href: String,
    pub mime_type: String,
    pub rel: String,
}

/// Parsed OPDS feed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsFeed {
    pub title: String,
    pub entries: Vec<OpdsEntry>,
    /// Next page link if paginated
    pub next_url: Option<String>,
    /// Search URL template (OpenSearch)
    pub search_url: Option<String>,
}

/// Build a reqwest client with timeout.
fn http_client() -> FolioResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| FolioError::network(format!("HTTP client error: {e}")))
}

/// Fetch and parse an OPDS feed from a URL.
pub fn fetch_feed(url: &str) -> FolioResult<OpdsFeed> {
    if !is_safe_url(url) {
        return Err(FolioError::invalid(
            "URL blocked: only public HTTP/HTTPS URLs are allowed.",
        ));
    }
    let client = http_client()?;
    let response = client
        .get(url)
        .header("User-Agent", "Folio/1.2 (OPDS reader)")
        .send()
        .map_err(|e| FolioError::network(format!("HTTP error: {e}")))?;
    if !response.status().is_success() {
        return Err(FolioError::network(format!("HTTP {}", response.status())));
    }
    let bytes = response
        .bytes()
        .map_err(|e| FolioError::network(format!("Read error: {e}")))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(FolioError::invalid("Response too large (limit: 5 MB)."));
    }
    let xml = String::from_utf8_lossy(&bytes).to_string();
    parse_feed(&xml, url)
}

/// Parse OPDS/Atom XML into structured data.
fn parse_feed(xml: &str, base_url: &str) -> FolioResult<OpdsFeed> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut feed_title = String::new();
    let mut entries: Vec<OpdsEntry> = Vec::new();
    let mut next_url: Option<String> = None;
    let mut search_url: Option<String> = None;

    // Current entry being parsed
    let mut in_entry = false;
    let mut entry_id = String::new();
    let mut entry_title = String::new();
    let mut entry_author = String::new();
    let mut entry_summary = String::new();
    let mut entry_cover: Option<String> = None;
    let mut entry_links: Vec<OpdsLink> = Vec::new();
    let mut entry_nav: Option<String> = None;

    // Track which element we're inside
    let mut current_tag = String::new();
    let mut in_author = false;
    let mut in_feed_title = false;

    let parsed_base = url::Url::parse(base_url).ok();
    let resolve = |href: &str| -> String {
        // Reject non-HTTP schemes outright (file://, javascript:, data:, etc.)
        if !href.is_empty()
            && !href.starts_with("http://")
            && !href.starts_with("https://")
            && !href.starts_with('/')
            && href.contains(':')
        {
            return String::new(); // blocked
        }
        if href.starts_with("http://") || href.starts_with("https://") {
            return href.to_string();
        }
        // RFC-compliant URL resolution via the url crate
        if let Some(ref base) = parsed_base {
            if let Ok(resolved) = base.join(href) {
                return resolved.to_string();
            }
        }
        String::new()
    };

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let ln = e.local_name();
                let local = std::str::from_utf8(ln.as_ref()).unwrap_or("");
                match local {
                    "entry" => {
                        in_entry = true;
                        entry_id.clear();
                        entry_title.clear();
                        entry_author.clear();
                        entry_summary.clear();
                        entry_cover = None;
                        entry_links.clear();
                        entry_nav = None;
                    }
                    "title" => {
                        if !in_entry && feed_title.is_empty() {
                            in_feed_title = true;
                        }
                        current_tag = "title".to_string();
                    }
                    "id" => {
                        current_tag = "id".to_string();
                    }
                    "name" if in_author => {
                        current_tag = "author_name".to_string();
                    }
                    "author" => {
                        in_author = true;
                    }
                    "summary" | "content" => {
                        current_tag = "summary".to_string();
                    }
                    // media:thumbnail (used by Standard Ebooks Atom feeds)
                    "thumbnail" if in_entry && entry_cover.is_none() => {
                        for attr in e.attributes().flatten() {
                            let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                            if key == "url" {
                                let url = attr.unescape_value().unwrap_or_default().to_string();
                                let url = resolve(&url);
                                entry_cover = Some(if url.starts_with("http://") {
                                    url.replacen("http://", "https://", 1)
                                } else {
                                    url
                                });
                            }
                        }
                    }
                    "link" => {
                        let mut href = String::new();
                        let mut rel = String::new();
                        let mut mime = String::new();
                        for attr in e.attributes().flatten() {
                            let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                            let val = attr.unescape_value().unwrap_or_default().to_string();
                            match key {
                                "href" => href = resolve(&val),
                                "rel" => rel = val,
                                "type" => mime = val,
                                _ => {}
                            }
                        }
                        if !href.is_empty() {
                            // Feed-level links
                            if !in_entry {
                                if rel == "next" {
                                    next_url = Some(href.clone());
                                } else if rel.contains("search") || mime.contains("opensearch") {
                                    search_url = Some(href.clone());
                                }
                            }
                            // Entry-level links
                            if in_entry {
                                // Cover/thumbnail
                                if rel.contains("thumbnail")
                                    || rel.contains("image")
                                    || (mime.starts_with("image/") && rel != "alternate")
                                {
                                    // Upgrade http to https for CSP compatibility
                                    let cover_href = if href.starts_with("http://") {
                                        href.replacen("http://", "https://", 1)
                                    } else {
                                        href.clone()
                                    };
                                    entry_cover = Some(cover_href);
                                }
                                // Navigation (sub-catalog)
                                if mime.contains("atom+xml")
                                    || mime.contains("opds-catalog")
                                    || rel.contains("subsection")
                                    || rel.contains("alternate") && mime.contains("atom")
                                {
                                    entry_nav = Some(href.clone());
                                }
                                // Acquisition (download)
                                if rel.contains("acquisition")
                                    || rel == "enclosure"
                                    || rel.is_empty()
                                        && (mime.contains("epub")
                                            || mime.contains("pdf")
                                            || mime.contains("zip")
                                            || mime.contains("octet"))
                                {
                                    entry_links.push(OpdsLink {
                                        href,
                                        mime_type: mime,
                                        rel,
                                    });
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) => {
                let text = e.unescape().unwrap_or_default().to_string();
                if in_feed_title && !in_entry {
                    feed_title = text.clone();
                    in_feed_title = false;
                }
                if in_entry {
                    match current_tag.as_str() {
                        "title" => entry_title.push_str(&text),
                        "id" => entry_id.push_str(&text),
                        "author_name" => entry_author.push_str(&text),
                        "summary" => entry_summary.push_str(&text),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let ln = e.local_name();
                let local = std::str::from_utf8(ln.as_ref()).unwrap_or("");
                match local {
                    "entry" => {
                        in_entry = false;
                        entries.push(OpdsEntry {
                            id: entry_id.clone(),
                            title: entry_title.clone(),
                            author: entry_author.clone(),
                            summary: entry_summary.clone(),
                            cover_url: entry_cover.clone(),
                            links: entry_links.clone(),
                            nav_url: entry_nav.clone(),
                        });
                    }
                    "author" => {
                        in_author = false;
                    }
                    "title" | "id" | "name" | "summary" | "content" => {
                        current_tag.clear();
                        in_feed_title = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(FolioError::invalid(format!("XML parse error: {e}"))),
            _ => {}
        }
        buf.clear();
    }

    // Resolve OpenSearch description URLs to direct search templates
    let resolved_search = search_url.and_then(|u| resolve_search_url(&u));

    Ok(OpdsFeed {
        title: feed_title,
        entries,
        next_url,
        search_url: resolved_search,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_feed_basic_entry() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Test Catalog</title>
          <entry>
            <id>urn:uuid:123</id>
            <title>My Book</title>
            <author><name>Jane Doe</name></author>
            <summary>A great book</summary>
            <link href="/download/book.epub" type="application/epub+zip" rel="http://opds-spec.org/acquisition"/>
          </entry>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com/opds").unwrap();
        assert_eq!(feed.title, "Test Catalog");
        assert_eq!(feed.entries.len(), 1);

        let entry = &feed.entries[0];
        assert_eq!(entry.id, "urn:uuid:123");
        assert_eq!(entry.title, "My Book");
        assert_eq!(entry.author, "Jane Doe");
        assert_eq!(entry.summary, "A great book");
        assert_eq!(entry.links.len(), 1);
        assert_eq!(
            entry.links[0].href,
            "https://example.com/download/book.epub"
        );
        assert_eq!(entry.links[0].mime_type, "application/epub+zip");
    }

    #[test]
    fn parse_feed_relative_url_resolution() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Test</title>
          <entry>
            <id>1</id>
            <title>Book</title>
            <link href="book.epub" type="application/epub+zip" rel="http://opds-spec.org/acquisition"/>
          </entry>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com/catalog/root.xml").unwrap();
        // Relative path should resolve against base directory
        assert_eq!(
            feed.entries[0].links[0].href,
            "https://example.com/catalog/book.epub"
        );
    }

    #[test]
    fn parse_feed_absolute_path_resolution() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Test</title>
          <entry>
            <id>1</id>
            <title>Book</title>
            <link href="/files/book.epub" type="application/epub+zip" rel="http://opds-spec.org/acquisition"/>
          </entry>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com/catalog/root.xml").unwrap();
        // Absolute path should use scheme+host only
        assert_eq!(
            feed.entries[0].links[0].href,
            "https://example.com/files/book.epub"
        );
    }

    #[test]
    fn parse_feed_full_url_unchanged() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Test</title>
          <entry>
            <id>1</id>
            <title>Book</title>
            <link href="https://cdn.example.com/book.epub" type="application/epub+zip" rel="http://opds-spec.org/acquisition"/>
          </entry>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com/opds").unwrap();
        assert_eq!(
            feed.entries[0].links[0].href,
            "https://cdn.example.com/book.epub"
        );
    }

    #[test]
    fn parse_feed_cover_http_upgraded_to_https() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Test</title>
          <entry>
            <id>1</id>
            <title>Book</title>
            <link href="http://covers.example.com/cover.jpg" type="image/jpeg" rel="http://opds-spec.org/image/thumbnail"/>
          </entry>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com/opds").unwrap();
        // Cover URLs should be upgraded from http to https
        assert_eq!(
            feed.entries[0].cover_url.as_deref(),
            Some("https://covers.example.com/cover.jpg")
        );
    }

    #[test]
    fn parse_feed_navigation_links() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Root</title>
          <entry>
            <id>1</id>
            <title>Science Fiction</title>
            <link href="/catalog/scifi" type="application/atom+xml" rel="subsection"/>
          </entry>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com/opds").unwrap();
        assert!(feed.entries[0].nav_url.is_some());
        assert_eq!(
            feed.entries[0].nav_url.as_deref(),
            Some("https://example.com/catalog/scifi")
        );
    }

    #[test]
    fn parse_feed_next_page_and_search() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Catalog</title>
          <link href="/opds?page=2" rel="next" type="application/atom+xml"/>
          <link href="/search?q={searchTerms}" rel="search" type="application/opensearchdescription+xml"/>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com/opds").unwrap();
        assert_eq!(
            feed.next_url.as_deref(),
            Some("https://example.com/opds?page=2")
        );
        assert_eq!(
            feed.search_url.as_deref(),
            Some("https://example.com/search?q={searchTerms}")
        );
    }

    #[test]
    fn parse_feed_empty_feed() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Empty</title>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com").unwrap();
        assert_eq!(feed.title, "Empty");
        assert!(feed.entries.is_empty());
        assert!(feed.next_url.is_none());
        assert!(feed.search_url.is_none());
    }

    #[test]
    fn parse_feed_invalid_xml() {
        let xml = "not xml at all <<<<";
        assert!(parse_feed(xml, "https://example.com").is_err());
    }

    #[test]
    fn parse_feed_multiple_entries() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Books</title>
          <entry>
            <id>1</id><title>Book One</title>
          </entry>
          <entry>
            <id>2</id><title>Book Two</title>
          </entry>
          <entry>
            <id>3</id><title>Book Three</title>
          </entry>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com").unwrap();
        assert_eq!(feed.entries.len(), 3);
        assert_eq!(feed.entries[0].title, "Book One");
        assert_eq!(feed.entries[2].title, "Book Three");
    }

    #[test]
    fn parse_feed_enclosure_links_treated_as_acquisition() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Standard Ebooks</title>
          <entry>
            <id>1</id>
            <title>Jenny</title>
            <link href="https://example.com/jenny.epub" rel="enclosure" type="application/epub+zip"/>
          </entry>
        </feed>"#;

        let feed = parse_feed(xml, "https://example.com").unwrap();
        assert_eq!(feed.entries[0].links.len(), 1);
        assert_eq!(
            feed.entries[0].links[0].href,
            "https://example.com/jenny.epub"
        );
        assert_eq!(feed.entries[0].links[0].mime_type, "application/epub+zip");
    }
}

/// Resolve a search URL — if it's an OpenSearch description XML, fetch it and
/// extract the Atom/OPDS template URL. Otherwise return it as-is.
pub fn resolve_search_url(url: &str) -> Option<String> {
    // If it already contains {searchTerms}, it's a direct template
    if url.contains("{searchTerms}") {
        return Some(url.to_string());
    }
    // Try fetching as OpenSearch description
    if !is_safe_url(url) {
        return None;
    }
    let client = http_client().ok()?;
    let response = client
        .get(url)
        .header("User-Agent", "Folio/1.2 (OPDS reader)")
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let xml = response.text().ok()?;

    // Parse and find the Atom/OPDS Url template
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let ln = e.local_name();
                let local = std::str::from_utf8(ln.as_ref()).unwrap_or("");
                if local.eq_ignore_ascii_case("url") {
                    let mut template = String::new();
                    let mut url_type = String::new();
                    for attr in e.attributes().flatten() {
                        let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                        let val = attr.unescape_value().unwrap_or_default().to_string();
                        match key {
                            "template" => template = val,
                            "type" => url_type = val,
                            _ => {}
                        }
                    }
                    // Prefer atom+xml / opds-catalog type
                    if !template.is_empty()
                        && (url_type.contains("atom") || url_type.contains("opds"))
                    {
                        return Some(template);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

/// Percent-encode a string for use in URLs.
pub fn url_encode(s: &str) -> String {
    s.replace('%', "%25")
        .replace(' ', "%20")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('#', "%23")
        .replace('+', "%2B")
}

/// Download a file from a URL to a local path.
pub fn download_file(url: &str, dest: &str) -> FolioResult<()> {
    if !is_safe_url(url) {
        return Err(FolioError::invalid(
            "URL blocked: only public HTTP/HTTPS URLs are allowed.",
        ));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120)) // longer timeout for file downloads
        .build()
        .map_err(|e| FolioError::network(format!("HTTP client error: {e}")))?;
    let response = client
        .get(url)
        .send()
        .map_err(|e| FolioError::network(format!("Download failed: {e}")))?;
    if !response.status().is_success() {
        return Err(FolioError::network(format!("HTTP {}", response.status())));
    }
    let bytes = response
        .bytes()
        .map_err(|e| FolioError::network(format!("Read error: {e}")))?;
    std::fs::write(dest, &bytes).map_err(|e| FolioError::io(format!("Write error: {e}")))?;
    Ok(())
}
