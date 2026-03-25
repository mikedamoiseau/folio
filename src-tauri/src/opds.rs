use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;

/// A single entry from an OPDS feed (book or navigation link).
#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
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

/// Fetch and parse an OPDS feed from a URL.
pub fn fetch_feed(url: &str) -> Result<OpdsFeed, String> {
    let response = reqwest::blocking::get(url).map_err(|e| format!("HTTP error: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let xml = response.text().map_err(|e| format!("Read error: {e}"))?;
    parse_feed(&xml, url)
}

/// Parse OPDS/Atom XML into structured data.
fn parse_feed(xml: &str, base_url: &str) -> Result<OpdsFeed, String> {
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

    let resolve = |href: &str| -> String {
        if href.starts_with("http://") || href.starts_with("https://") {
            return href.to_string();
        }
        // Simple relative URL resolution
        if href.starts_with('/') {
            // Absolute path — combine with scheme+host
            if let Some(idx) = base_url.find("://") {
                if let Some(slash) = base_url[idx + 3..].find('/') {
                    return format!("{}{}", &base_url[..idx + 3 + slash], href);
                }
            }
            return format!("{}{}", base_url.trim_end_matches('/'), href);
        }
        // Relative path — combine with base directory
        let base_dir = if let Some(idx) = base_url.rfind('/') {
            &base_url[..idx + 1]
        } else {
            base_url
        };
        format!("{}{}", base_dir, href)
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
                                    entry_cover = Some(href.clone());
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
            Err(e) => return Err(format!("XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(OpdsFeed {
        title: feed_title,
        entries,
        next_url,
        search_url,
    })
}

/// Download a file from a URL to a local path.
pub fn download_file(url: &str, dest: &str) -> Result<(), String> {
    let response = reqwest::blocking::get(url).map_err(|e| format!("Download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let bytes = response.bytes().map_err(|e| format!("Read error: {e}"))?;
    std::fs::write(dest, &bytes).map_err(|e| format!("Write error: {e}"))?;
    Ok(())
}
