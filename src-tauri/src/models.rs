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
    pub field: String,    // author | format | date_added | reading_progress
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
