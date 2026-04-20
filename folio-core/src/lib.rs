//! Folio core library — UI- and IPC-free shared functionality.
//!
//! This crate hosts data models, the error taxonomy, and shared utilities
//! consumed by both the Tauri desktop app (`src-tauri/`) and any future
//! headless/server binaries. It deliberately has zero Tauri or axum
//! dependencies so every module is reusable from any Rust context.
//!
//! See `docs/ROADMAP.md` #63 for the extraction plan.

pub mod backup;
pub mod cbr;
pub mod cbz;
pub mod db;
pub mod enrichment;
pub mod epub;
pub mod error;
pub mod isbn;
pub mod models;
pub mod opds;
pub mod openlibrary;
pub mod page_cache;
pub mod paths;
pub mod pdf;
pub mod providers;
pub mod storage;
pub mod sync;

// Flat re-exports for common types so consumers can write
// `use folio_core::{FolioError, FolioResult, Book}` without the extra
// module prefix.
pub use error::{FolioError, FolioResult};
