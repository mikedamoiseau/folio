//! Offline dictionary — reads a prebuilt WordNet-derived SQLite artifact and
//! resolves word lookups with light morphological normalization. No Tauri
//! dependency.
//!
//! The artifact is a **separate, read-only secondary database** (the first in
//! the codebase) downloaded on demand — the desktop crate installs it via the
//! gzip/download helpers added alongside this module. This file owns the parts
//! that don't touch the network:
//!   - [`ARTIFACT_SCHEMA_VERSION`] — the schema contract the app understands,
//!   - [`inspect`] — a cheap status probe for the settings UI,
//!   - [`open_readonly_pool`] — a small `READ_ONLY` r2d2 pool,
//!   - [`lookup`] + morphy — exact / exception / suffix-rule resolution.
//!
//! The artifact schema (built by `scripts/build_dictionary_db.py`) is:
//! ```sql
//! meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)         -- schema_version, wordnet_version, ...
//! words(id INTEGER PRIMARY KEY, word TEXT UNIQUE)          -- lowercase lemmas
//! senses(id, word_id, pos, sense_num, gloss, examples, synonyms)
//! lemma_exceptions(form, pos, lemma)                       -- morphy exception tables (*.exc)
//! ```
//! `examples` and `synonyms` are `\n`-joined lists (WordNet glosses/examples
//! are single-line, so a newline separator is unambiguous).

use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

use crate::db::DbPool;
use crate::error::{FolioError, FolioResult};

/// Schema version this build understands. A mismatch is reported as
/// [`DictionaryState::Corrupt`] so the UI offers a re-download. A future
/// incompatible format ships under a new `dictionary-vN` release tag with new
/// URL/SHA consts — this constant is bumped in lockstep with that layout.
pub const ARTIFACT_SCHEMA_VERSION: i64 = 1;

/// File name of the decompressed artifact inside its directory.
pub const ARTIFACT_FILE_NAME: &str = "dictionary.db";

/// On-disk state of the artifact directory. Serialized lowercase so the
/// frontend receives `"missing" | "ready" | "corrupt"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DictionaryState {
    /// No artifact file present.
    Missing,
    /// Artifact present, opens read-only, schema version matches.
    Ready,
    /// Artifact present but unreadable or schema-mismatched — re-download.
    Corrupt,
}

/// Status of the installed dictionary artifact, surfaced to the settings UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryStatus {
    pub state: DictionaryState,
    /// WordNet version string from `meta` (only when `Ready`).
    pub wordnet_version: Option<String>,
    /// Size of the decompressed artifact on disk, in bytes.
    pub size_bytes: Option<u64>,
}

/// A single dictionary sense, ready for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionarySense {
    /// Part of speech: `n` | `v` | `a` | `r`.
    pub pos: String,
    /// 1-based sense number in WordNet frequency order.
    pub sense_num: i64,
    pub gloss: String,
    pub examples: Vec<String>,
    pub synonyms: Vec<String>,
}

/// Result of a successful lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryEntry {
    /// The normalized (lowercased) query word.
    pub word: String,
    /// The lemma actually matched. Equals `word` for an exact hit; differs
    /// after morphological normalization (e.g. `"running"` → `"run"`) so the
    /// card can show a "running → run" note.
    pub matched_word: String,
    pub senses: Vec<DictionarySense>,
}

/// Probe the artifact directory. Never errors — any failure to read a present
/// file resolves to [`DictionaryState::Corrupt`].
pub fn inspect(dir: &Path) -> DictionaryStatus {
    let db_path = dir.join(ARTIFACT_FILE_NAME);
    let size_bytes = match std::fs::metadata(&db_path) {
        Ok(m) => m.len(),
        Err(_) => {
            return DictionaryStatus {
                state: DictionaryState::Missing,
                wordnet_version: None,
                size_bytes: None,
            };
        }
    };
    match read_meta(&db_path) {
        Ok(Some(meta)) if meta.schema_version == ARTIFACT_SCHEMA_VERSION => DictionaryStatus {
            state: DictionaryState::Ready,
            wordnet_version: Some(meta.wordnet_version),
            size_bytes: Some(size_bytes),
        },
        _ => DictionaryStatus {
            state: DictionaryState::Corrupt,
            wordnet_version: None,
            size_bytes: Some(size_bytes),
        },
    }
}

/// Open a small read-only connection pool over the installed artifact. Errors
/// with [`FolioError::NotFound`] when the artifact is missing so callers can
/// route the user to the settings download flow.
pub fn open_readonly_pool(dir: &Path) -> FolioResult<DbPool> {
    let db_path = dir.join(ARTIFACT_FILE_NAME);
    if !db_path.exists() {
        return Err(FolioError::not_found("dictionary artifact not installed"));
    }
    // READ_ONLY: never mutate the artifact and never create a fresh empty DB if
    // the file vanished between the check above and open. `max_size(2)` — a
    // secondary pool alongside the main library pool; lookups are quick.
    let manager =
        SqliteConnectionManager::file(&db_path).with_flags(OpenFlags::SQLITE_OPEN_READ_ONLY);
    r2d2::Pool::builder()
        .max_size(2)
        .connection_timeout(Duration::from_secs(5))
        .build(manager)
        .map_err(|e| FolioError::database(e.to_string()))
}

/// Look a word up. Returns `Ok(None)` for an empty query or a word (and all of
/// its morphological candidates) absent from the artifact.
pub fn lookup(conn: &Connection, word: &str) -> FolioResult<Option<DictionaryEntry>> {
    let normalized = word.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(None);
    }
    let Some(matched) = resolve_lemma(conn, &normalized)? else {
        return Ok(None);
    };
    let senses = load_senses(conn, &matched)?;
    if senses.is_empty() {
        return Ok(None);
    }
    Ok(Some(DictionaryEntry {
        word: normalized,
        matched_word: matched,
        senses,
    }))
}

struct ArtifactMeta {
    schema_version: i64,
    wordnet_version: String,
}

fn open_readonly_conn(db_path: &Path) -> FolioResult<Connection> {
    Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| FolioError::database(e.to_string()))
}

fn read_meta(db_path: &Path) -> FolioResult<Option<ArtifactMeta>> {
    let conn = open_readonly_conn(db_path)?;
    let schema_version: Option<i64> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|s| s.parse().ok());
    let wordnet_version: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'wordnet_version'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match (schema_version, wordnet_version) {
        (Some(schema_version), Some(wordnet_version)) => Ok(Some(ArtifactMeta {
            schema_version,
            wordnet_version,
        })),
        _ => Ok(None),
    }
}

fn word_exists(conn: &Connection, word: &str) -> FolioResult<bool> {
    let mut stmt = conn.prepare_cached("SELECT 1 FROM words WHERE word = ?1 LIMIT 1")?;
    Ok(stmt.exists([word])?)
}

/// Resolve a normalized query to a lemma that exists in `words`, trying, in
/// order: (1) exact match, (2) `lemma_exceptions` (irregular forms), (3) static
/// suffix-detachment rules. Returns the first candidate present in `words`.
fn resolve_lemma(conn: &Connection, word: &str) -> FolioResult<Option<String>> {
    if word_exists(conn, word)? {
        return Ok(Some(word.to_string()));
    }

    let mut stmt =
        conn.prepare_cached("SELECT DISTINCT lemma FROM lemma_exceptions WHERE form = ?1")?;
    let exceptions: Vec<String> = stmt
        .query_map([word], |r| r.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;
    for lemma in exceptions {
        if word_exists(conn, &lemma)? {
            return Ok(Some(lemma));
        }
    }

    for candidate in morphy_candidates(word) {
        if word_exists(conn, &candidate)? {
            return Ok(Some(candidate));
        }
    }

    Ok(None)
}

fn push_unique(out: &mut Vec<String>, candidate: String) {
    // Reject stems too short to be real lemmas; skip duplicates while keeping
    // first-seen order (order determines which base form wins in `resolve_lemma`).
    if candidate.len() >= 2 && !out.contains(&candidate) {
        out.push(candidate);
    }
}

/// If `stem` ends in a doubled consonant, return it with the final letter
/// dropped (e.g. `"runn"` → `"run"`). Powers `-ing`/`-ed` de-doubling so
/// `"running"` resolves to `"run"`.
fn undouble_final_consonant(stem: &str) -> Option<String> {
    let bytes = stem.as_bytes();
    let n = bytes.len();
    if n >= 2 {
        let last = bytes[n - 1].to_ascii_lowercase();
        let prev = bytes[n - 2].to_ascii_lowercase();
        if last == prev && last.is_ascii_alphabetic() && !b"aeiou".contains(&last) {
            return Some(stem[..n - 1].to_string());
        }
    }
    None
}

/// Static suffix-detachment candidates mirroring WordNet's morphy. Each is only
/// a *possible* base form; `resolve_lemma` keeps a candidate only if it is
/// present in `words`.
fn morphy_candidates(word: &str) -> Vec<String> {
    // (suffix, replacement) — noun, then verb, then adjective rules.
    const RULES: &[(&str, &str)] = &[
        // noun plurals
        ("ses", "s"),
        ("xes", "x"),
        ("zes", "z"),
        ("ches", "ch"),
        ("shes", "sh"),
        ("men", "man"),
        ("ies", "y"),
        // verb inflections
        ("es", "e"),
        ("es", ""),
        ("ed", "e"),
        ("ed", ""),
        ("ing", "e"),
        ("ing", ""),
        // shared trailing -s (noun plural / 3rd-person verb)
        ("s", ""),
        // comparative / superlative adjectives
        ("er", ""),
        ("er", "e"),
        ("est", ""),
        ("est", "e"),
    ];

    let mut out: Vec<String> = Vec::new();
    for (suffix, replacement) in RULES {
        if let Some(stem) = word.strip_suffix(suffix) {
            push_unique(&mut out, format!("{stem}{replacement}"));
        }
    }
    // Consonant de-doubling for -ing / -ed (running → runn → run).
    for suffix in ["ing", "ed"] {
        if let Some(stem) = word.strip_suffix(suffix) {
            if let Some(undoubled) = undouble_final_consonant(stem) {
                push_unique(&mut out, undoubled);
            }
        }
    }
    out
}

fn split_multi(value: Option<String>) -> Vec<String> {
    value
        .map(|v| {
            v.split('\n')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn load_senses(conn: &Connection, lemma: &str) -> FolioResult<Vec<DictionarySense>> {
    let mut stmt = conn.prepare_cached(
        "SELECT s.pos, s.sense_num, s.gloss, s.examples, s.synonyms
         FROM senses s JOIN words w ON w.id = s.word_id
         WHERE w.word = ?1
         ORDER BY s.pos, s.sense_num
         LIMIT 40",
    )?;
    let senses = stmt
        .query_map([lemma], |r| {
            Ok(DictionarySense {
                pos: r.get(0)?,
                sense_num: r.get(1)?,
                gloss: r.get(2)?,
                examples: split_multi(r.get::<_, Option<String>>(3)?),
                synonyms: split_multi(r.get::<_, Option<String>>(4)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(senses)
}

/// Build a tiny synthetic artifact at `dir/dictionary.db` for tests. Contains a
/// handful of words exercising every lookup path: exact match, an irregular
/// exception (`mice` → `mouse`), and suffix rules (`cats` → `cat`,
/// `running` → `run`). Exposed under `test-utils` so the desktop crate's
/// integration tests can build a real artifact without the network.
#[cfg(any(test, feature = "test-utils"))]
#[doc(hidden)]
pub fn write_test_artifact(dir: &Path) -> FolioResult<std::path::PathBuf> {
    std::fs::create_dir_all(dir)?;
    let db_path = dir.join(ARTIFACT_FILE_NAME);
    let conn = Connection::open(&db_path)?;
    conn.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
         CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE);
         CREATE TABLE senses (
           id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL REFERENCES words(id),
           pos TEXT NOT NULL, sense_num INTEGER NOT NULL,
           gloss TEXT NOT NULL, examples TEXT, synonyms TEXT);
         CREATE INDEX idx_senses_word ON senses(word_id, pos, sense_num);
         CREATE TABLE lemma_exceptions (form TEXT, pos TEXT, lemma TEXT,
           PRIMARY KEY (form, pos, lemma)) WITHOUT ROWID;",
    )?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES
           ('schema_version', ?1), ('wordnet_version', '3.1'),
           ('license', 'WordNet 3.1 License')",
        [ARTIFACT_SCHEMA_VERSION.to_string()],
    )?;
    // (word, pos, sense_num, gloss, examples, synonyms)
    let rows: &[(&str, &str, i64, &str, &str, &str)] = &[
        (
            "cat",
            "n",
            1,
            "feline mammal",
            "the cat sat",
            "feline\nkitty",
        ),
        (
            "run",
            "v",
            1,
            "move fast on foot",
            "he can run",
            "sprint\ndash",
        ),
        ("run", "n", 1, "a score in baseball", "", ""),
        ("mouse", "n", 1, "small rodent", "a quiet mouse", "rodent"),
        ("light", "n", 1, "electromagnetic radiation", "", ""),
        (
            "light",
            "a",
            1,
            "of little weight",
            "a light bag",
            "weightless",
        ),
    ];
    for (word, pos, sense_num, gloss, examples, synonyms) in rows {
        conn.execute("INSERT OR IGNORE INTO words (word) VALUES (?1)", [word])?;
        conn.execute(
            "INSERT INTO senses (word_id, pos, sense_num, gloss, examples, synonyms)
             VALUES ((SELECT id FROM words WHERE word = ?1), ?2, ?3, ?4,
                     NULLIF(?5, ''), NULLIF(?6, ''))",
            rusqlite::params![word, pos, sense_num, gloss, examples, synonyms],
        )?;
    }
    conn.execute(
        "INSERT INTO lemma_exceptions (form, pos, lemma) VALUES ('mice', 'n', 'mouse')",
        [],
    )?;
    Ok(db_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn morphy_generates_expected_candidates() {
        assert!(morphy_candidates("cats").contains(&"cat".to_string()));
        assert!(morphy_candidates("boxes").contains(&"box".to_string()));
        assert!(morphy_candidates("running").contains(&"run".to_string()));
        // -er does not de-double, so "bigger" never yields "big".
        assert!(!morphy_candidates("bigger").contains(&"big".to_string()));
        assert!(morphy_candidates("studies").contains(&"study".to_string()));
    }

    #[test]
    fn inspect_reports_missing_ready_and_corrupt() {
        let dir = tempdir().unwrap();
        assert_eq!(inspect(dir.path()).state, DictionaryState::Missing);

        write_test_artifact(dir.path()).unwrap();
        let status = inspect(dir.path());
        assert_eq!(status.state, DictionaryState::Ready);
        assert_eq!(status.wordnet_version.as_deref(), Some("3.1"));
        assert!(status.size_bytes.unwrap() > 0);

        // Truncate the file to garbage → corrupt.
        std::fs::write(dir.path().join(ARTIFACT_FILE_NAME), b"not a sqlite db").unwrap();
        assert_eq!(inspect(dir.path()).state, DictionaryState::Corrupt);
    }

    #[test]
    fn lookup_resolves_exact_exception_and_suffix_forms() {
        let dir = tempdir().unwrap();
        write_test_artifact(dir.path()).unwrap();
        let pool = open_readonly_pool(dir.path()).unwrap();
        let conn = pool.get().unwrap();

        // Exact.
        let entry = lookup(&conn, "cat").unwrap().unwrap();
        assert_eq!(entry.matched_word, "cat");
        assert_eq!(entry.senses.len(), 1);
        assert_eq!(entry.senses[0].gloss, "feline mammal");
        assert_eq!(entry.senses[0].synonyms, vec!["feline", "kitty"]);

        // Suffix rule: cats → cat.
        assert_eq!(lookup(&conn, "cats").unwrap().unwrap().matched_word, "cat");
        // Suffix rule with de-doubling: running → run.
        let running = lookup(&conn, "running").unwrap().unwrap();
        assert_eq!(running.matched_word, "run");
        // Exception table: mice → mouse.
        assert_eq!(
            lookup(&conn, "mice").unwrap().unwrap().matched_word,
            "mouse"
        );

        // Case + surrounding whitespace normalized.
        assert_eq!(
            lookup(&conn, "  CAT ").unwrap().unwrap().matched_word,
            "cat"
        );
    }

    #[test]
    fn lookup_returns_multiple_pos_ordered() {
        let dir = tempdir().unwrap();
        write_test_artifact(dir.path()).unwrap();
        let pool = open_readonly_pool(dir.path()).unwrap();
        let conn = pool.get().unwrap();

        let run = lookup(&conn, "run").unwrap().unwrap();
        // Two senses: adjective/noun 'n' then verb 'v' (ORDER BY pos).
        assert_eq!(run.senses.len(), 2);
        assert_eq!(run.senses[0].pos, "n");
        assert_eq!(run.senses[1].pos, "v");
    }

    #[test]
    fn lookup_unknown_and_empty_return_none() {
        let dir = tempdir().unwrap();
        write_test_artifact(dir.path()).unwrap();
        let pool = open_readonly_pool(dir.path()).unwrap();
        let conn = pool.get().unwrap();

        assert!(lookup(&conn, "zzzznotaword").unwrap().is_none());
        assert!(lookup(&conn, "   ").unwrap().is_none());
    }

    #[test]
    fn open_readonly_pool_missing_is_not_found() {
        let dir = tempdir().unwrap();
        let err = open_readonly_pool(dir.path()).unwrap_err();
        assert_eq!(err.kind(), "NotFound");
    }
}
