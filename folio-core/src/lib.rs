//! Folio core library — UI- and IPC-free shared functionality.
//!
//! This crate hosts data models, the error taxonomy, and shared utilities
//! consumed by both the Tauri desktop app (`src-tauri/`) and any future
//! headless/server binaries. It deliberately has zero Tauri or axum
//! dependencies so every module is reusable from any Rust context.
//!
//! See `docs/ROADMAP.md` #63 for the extraction plan.

pub mod error;
pub mod models;
pub mod paths;

// Flat re-exports for common types so consumers can write
// `use folio_core::{FolioError, FolioResult, Book}` without the extra
// module prefix.
pub use error::{FolioError, FolioResult};
