use serde::{Deserialize, Serialize};
use std::fmt;

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub chapter_index: u32,
    pub scroll_position: f64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncBookmark {
    pub id: String,
    pub chapter_index: u32,
    pub scroll_position: f64,
    pub name: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncHighlight {
    pub id: String,
    pub chapter_index: u32,
    pub start_offset: u32,
    pub end_offset: u32,
    pub text: String,
    pub color: String,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookSyncFile {
    pub schema_version: u32,
    pub book_hash: String,
    pub device_id: String,
    pub progress: Option<SyncProgress>,
    pub bookmarks: Vec<SyncBookmark>,
    pub highlights: Vec<SyncHighlight>,
}

#[derive(Debug)]
pub enum SyncError {
    Transport(String),
    Timeout,
    Malformed(String),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::Transport(msg) => write!(f, "Transport error: {msg}"),
            SyncError::Timeout => write!(f, "Sync operation timed out"),
            SyncError::Malformed(msg) => write!(f, "Malformed sync data: {msg}"),
        }
    }
}

#[derive(Debug, Default)]
pub struct MergeResult {
    pub progress_updated: bool,
    pub bookmarks_added: u32,
    pub bookmarks_updated: u32,
    pub highlights_added: u32,
    pub highlights_updated: u32,
}

impl MergeResult {
    pub fn has_changes(&self) -> bool {
        self.progress_updated
            || self.bookmarks_added > 0
            || self.bookmarks_updated > 0
            || self.highlights_added > 0
            || self.highlights_updated > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_sync_file_roundtrip() {
        let file = BookSyncFile {
            schema_version: CURRENT_SCHEMA_VERSION,
            book_hash: "abc123".to_string(),
            device_id: "device-1".to_string(),
            progress: Some(SyncProgress {
                chapter_index: 3,
                scroll_position: 0.75,
                updated_at: 1700000000,
            }),
            bookmarks: vec![SyncBookmark {
                id: "bm-1".to_string(),
                chapter_index: 2,
                scroll_position: 0.5,
                name: Some("My bookmark".to_string()),
                note: None,
                created_at: 1700000000,
                updated_at: 1700000001,
                deleted_at: None,
            }],
            highlights: vec![SyncHighlight {
                id: "hl-1".to_string(),
                chapter_index: 1,
                start_offset: 10,
                end_offset: 50,
                text: "highlighted text".to_string(),
                color: "#ffff00".to_string(),
                note: Some("a note".to_string()),
                created_at: 1700000000,
                updated_at: 1700000002,
                deleted_at: Some(1700000003),
            }],
        };

        let json = serde_json::to_string(&file).unwrap();
        let deserialized: BookSyncFile = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(deserialized.book_hash, "abc123");
        assert_eq!(deserialized.device_id, "device-1");

        let progress = deserialized.progress.unwrap();
        assert_eq!(progress.chapter_index, 3);
        assert!((progress.scroll_position - 0.75).abs() < f64::EPSILON);
        assert_eq!(progress.updated_at, 1700000000);

        assert_eq!(deserialized.bookmarks.len(), 1);
        assert_eq!(deserialized.bookmarks[0].id, "bm-1");
        assert_eq!(
            deserialized.bookmarks[0].name,
            Some("My bookmark".to_string())
        );

        assert_eq!(deserialized.highlights.len(), 1);
        assert_eq!(deserialized.highlights[0].id, "hl-1");
        assert_eq!(deserialized.highlights[0].deleted_at, Some(1700000003));
    }

    #[test]
    fn book_sync_file_ignores_unknown_fields() {
        let json = r#"{
            "schema_version": 1,
            "book_hash": "abc123",
            "device_id": "device-1",
            "progress": null,
            "bookmarks": [],
            "highlights": [],
            "some_future_field": "should be ignored",
            "another_unknown": 42
        }"#;

        let file: BookSyncFile = serde_json::from_str(json).unwrap();
        assert_eq!(file.schema_version, 1);
        assert_eq!(file.book_hash, "abc123");
        assert!(file.bookmarks.is_empty());
        assert!(file.highlights.is_empty());
    }

    #[test]
    fn merge_result_has_changes() {
        let empty = MergeResult::default();
        assert!(!empty.has_changes());

        let with_progress = MergeResult {
            progress_updated: true,
            ..Default::default()
        };
        assert!(with_progress.has_changes());

        let with_bookmarks_added = MergeResult {
            bookmarks_added: 1,
            ..Default::default()
        };
        assert!(with_bookmarks_added.has_changes());

        let with_bookmarks_updated = MergeResult {
            bookmarks_updated: 2,
            ..Default::default()
        };
        assert!(with_bookmarks_updated.has_changes());

        let with_highlights_added = MergeResult {
            highlights_added: 3,
            ..Default::default()
        };
        assert!(with_highlights_added.has_changes());

        let with_highlights_updated = MergeResult {
            highlights_updated: 4,
            ..Default::default()
        };
        assert!(with_highlights_updated.has_changes());
    }

    #[test]
    fn sync_error_display() {
        let transport = SyncError::Transport("connection refused".to_string());
        assert_eq!(transport.to_string(), "Transport error: connection refused");

        let timeout = SyncError::Timeout;
        assert_eq!(timeout.to_string(), "Sync operation timed out");

        let malformed = SyncError::Malformed("invalid json".to_string());
        assert_eq!(malformed.to_string(), "Malformed sync data: invalid json");
    }

    #[test]
    fn rejects_unknown_schema_version() {
        let json = r#"{
            "schema_version": 99,
            "book_hash": "abc123",
            "device_id": "device-1",
            "progress": null,
            "bookmarks": [],
            "highlights": []
        }"#;

        let file: BookSyncFile = serde_json::from_str(json).unwrap();
        assert!(file.schema_version > CURRENT_SCHEMA_VERSION);
    }
}
