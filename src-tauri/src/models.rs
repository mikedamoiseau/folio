use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Epub,
    Cbz,
    Cbr,
    Pdf,
}

impl std::fmt::Display for BookFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BookFormat::Epub => write!(f, "epub"),
            BookFormat::Cbz => write!(f, "cbz"),
            BookFormat::Cbr => write!(f, "cbr"),
            BookFormat::Pdf => write!(f, "pdf"),
        }
    }
}

impl std::str::FromStr for BookFormat {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "epub" => Ok(BookFormat::Epub),
            "cbz" => Ok(BookFormat::Cbz),
            "cbr" => Ok(BookFormat::Cbr),
            "pdf" => Ok(BookFormat::Pdf),
            _ => Err(format!("unknown book format: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: String,
    pub file_path: String,
    pub cover_path: Option<String>,
    pub total_chapters: u32,
    pub added_at: i64,
    pub format: BookFormat,
    pub file_hash: Option<String>,
    pub description: Option<String>,
    pub genres: Option<String>, // JSON array string
    pub rating: Option<f64>,
    pub isbn: Option<String>,
    pub openlibrary_key: Option<String>,
    pub enrichment_status: Option<String>,
    pub series: Option<String>,
    pub volume: Option<u32>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub publish_year: Option<u16>,
    pub is_imported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadingProgress {
    pub book_id: String,
    pub chapter_index: u32,
    pub scroll_position: f64,
    pub last_read_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub chapter_index: u32,
    pub scroll_position: f64,
    pub name: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    pub book_id: String,
    pub chapter_index: u32,
    pub text: String,
    pub color: String,
    pub note: Option<String>,
    pub start_offset: u32,
    pub end_offset: u32,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum CollectionType {
    Manual,
    Automated,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRule {
    pub id: String,
    pub collection_id: String,
    pub field: String, // author | filename | series | language | publisher | description | format | tag | date_added | reading_progress
    pub operator: String, // contains | equals | last_n_days
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewRuleInput {
    pub field: String,
    pub operator: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub r#type: CollectionType,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub rules: Vec<CollectionRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub timestamp: i64,
    pub action: String,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub entity_name: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFont {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub file_path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesInfo {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed_count: u32,
    pub removed_books: Vec<CleanupEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupEntry {
    pub id: String,
    pub title: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupProgress {
    pub current: u32,
    pub total: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_format_display() {
        assert_eq!(BookFormat::Epub.to_string(), "epub");
        assert_eq!(BookFormat::Cbz.to_string(), "cbz");
        assert_eq!(BookFormat::Cbr.to_string(), "cbr");
        assert_eq!(BookFormat::Pdf.to_string(), "pdf");
    }

    #[test]
    fn book_format_from_str_valid() {
        assert_eq!("epub".parse::<BookFormat>().unwrap(), BookFormat::Epub);
        assert_eq!("cbz".parse::<BookFormat>().unwrap(), BookFormat::Cbz);
        assert_eq!("cbr".parse::<BookFormat>().unwrap(), BookFormat::Cbr);
        assert_eq!("pdf".parse::<BookFormat>().unwrap(), BookFormat::Pdf);
    }

    #[test]
    fn book_format_from_str_invalid() {
        let err = "mobi".parse::<BookFormat>().unwrap_err();
        assert!(err.contains("unknown book format"));
        assert!(err.contains("mobi"));
    }

    #[test]
    fn book_format_from_str_case_sensitive() {
        // FromStr is case-sensitive — uppercase should fail
        assert!("EPUB".parse::<BookFormat>().is_err());
        assert!("Pdf".parse::<BookFormat>().is_err());
    }

    #[test]
    fn book_format_serde_roundtrip() {
        let format = BookFormat::Epub;
        let json = serde_json::to_string(&format).unwrap();
        assert_eq!(json, "\"epub\"");
        let back: BookFormat = serde_json::from_str(&json).unwrap();
        assert_eq!(back, BookFormat::Epub);
    }

    #[test]
    fn book_format_serde_all_variants() {
        for (variant, expected) in [
            (BookFormat::Epub, "\"epub\""),
            (BookFormat::Cbz, "\"cbz\""),
            (BookFormat::Cbr, "\"cbr\""),
            (BookFormat::Pdf, "\"pdf\""),
        ] {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, expected);
        }
    }
}
