//! Storage abstraction for Folio's persistent artifacts.
//!
//! Book files, covers, and related blobs are accessed through a `Storage`
//! trait so the backend can be swapped (local filesystem today, S3 or other
//! object stores in the paid `folio-server`). The desktop app uses
//! [`LocalStorage`] rooted at the library folder; this keeps on-disk layout
//! and behavior identical to the pre-refactor code.
//!
//! # Key scheme
//!
//! Keys are opaque UTF-8 strings using `/` as a separator. They are always
//! relative — leading slashes, empty segments, and `..` segments are
//! rejected. Valid examples:
//!
//! - `books/abc123.epub`
//! - `covers/42/cover.jpg`
//! - `a.epub`
//!
//! # Roadmap
//!
//! See `docs/ROADMAP.md` #64.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{FolioError, FolioResult};

/// Backend-agnostic interface for reading and writing Folio's persistent
/// artifacts.
///
/// All implementations must be thread-safe (`Send + Sync`). Keys must pass
/// [`validate_key`] — paths containing `..`, absolute paths, or empty
/// segments are rejected.
pub trait Storage: Send + Sync {
    /// Write the given bytes at `key`, overwriting any existing object.
    fn put(&self, key: &str, bytes: &[u8]) -> FolioResult<()>;

    /// Read the entire object at `key` into memory.
    fn get(&self, key: &str) -> FolioResult<Vec<u8>>;

    /// Return `true` if an object exists at `key`.
    fn exists(&self, key: &str) -> FolioResult<bool>;

    /// Delete the object at `key`. Deleting a missing key is a no-op.
    fn delete(&self, key: &str) -> FolioResult<()>;

    /// List all keys whose path starts with `prefix`. Pass `""` to list
    /// everything. Returns keys in implementation-defined order.
    fn list(&self, prefix: &str) -> FolioResult<Vec<String>>;

    /// Return the byte length of the object at `key`.
    fn size(&self, key: &str) -> FolioResult<u64>;

    /// Copy a file from the local filesystem into storage at `key`.
    ///
    /// Backends that can do this efficiently (e.g. `LocalStorage` with
    /// `std::fs::copy`) should override; the default falls back to
    /// read-then-put.
    fn put_path(&self, key: &str, src: &Path) -> FolioResult<()> {
        let bytes = fs::read(src)?;
        self.put(key, &bytes)
    }

    /// Resolve `key` to a local filesystem path that callers can hand to
    /// libraries requiring `&Path` access (pdfium, zip, unrar).
    ///
    /// For [`LocalStorage`] this returns the underlying path directly.
    /// Remote backends must first materialize the object to a local cache
    /// — those implementations are introduced in the paid `folio-server`
    /// crate.
    fn local_path(&self, key: &str) -> FolioResult<PathBuf>;
}

/// Reject keys that are absolute, empty, or contain `..` / empty segments.
///
/// Returned error is [`FolioError::InvalidInput`] so callers surface a
/// consistent message to users.
pub fn validate_key(key: &str) -> FolioResult<()> {
    if key.is_empty() {
        return Err(FolioError::invalid("storage key is empty"));
    }
    if key.starts_with('/') || key.starts_with('\\') {
        return Err(FolioError::invalid(format!(
            "storage key must be relative: {key}"
        )));
    }
    // Reject Windows drive prefixes like `C:`.
    if key.len() >= 2 && key.as_bytes()[1] == b':' {
        return Err(FolioError::invalid(format!(
            "storage key must be relative: {key}"
        )));
    }
    for segment in key.split(['/', '\\']) {
        if segment.is_empty() {
            return Err(FolioError::invalid(format!(
                "storage key has empty segment: {key}"
            )));
        }
        if segment == ".." || segment == "." {
            return Err(FolioError::invalid(format!(
                "storage key contains traversal segment: {key}"
            )));
        }
    }
    Ok(())
}

/// Filesystem-backed [`Storage`] rooted at a directory on disk.
///
/// The desktop app configures one `LocalStorage` per profile, pointing at
/// the user's library folder. Every key resolves to
/// `{root}/{key}` with `/` translated to the platform separator.
pub struct LocalStorage {
    root: PathBuf,
}

impl LocalStorage {
    /// Create a new `LocalStorage` rooted at `root`. The directory is
    /// created if it does not already exist.
    pub fn new(root: impl Into<PathBuf>) -> FolioResult<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    /// Return the root directory for this storage.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn resolve(&self, key: &str) -> FolioResult<PathBuf> {
        validate_key(key)?;
        let mut path = self.root.clone();
        for segment in key.split('/') {
            path.push(segment);
        }
        Ok(path)
    }
}

impl Storage for LocalStorage {
    fn put(&self, key: &str, bytes: &[u8]) -> FolioResult<()> {
        let path = self.resolve(key)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, bytes)?;
        Ok(())
    }

    fn get(&self, key: &str) -> FolioResult<Vec<u8>> {
        let path = self.resolve(key)?;
        Ok(fs::read(&path)?)
    }

    fn exists(&self, key: &str) -> FolioResult<bool> {
        let path = self.resolve(key)?;
        Ok(path.exists())
    }

    fn delete(&self, key: &str) -> FolioResult<()> {
        let path = self.resolve(key)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    fn list(&self, prefix: &str) -> FolioResult<Vec<String>> {
        // A prefix is a starts-with filter — not a key. Reject absolute and
        // traversal forms, but accept trailing slashes and other shapes that
        // are invalid as keys.
        if prefix.starts_with('/') || prefix.starts_with('\\') {
            return Err(FolioError::invalid(format!(
                "list prefix must be relative: {prefix}"
            )));
        }
        if prefix.split(['/', '\\']).any(|s| s == "..") {
            return Err(FolioError::invalid(format!(
                "list prefix contains traversal segment: {prefix}"
            )));
        }
        let mut out = Vec::new();
        walk(&self.root, &self.root, &mut out)?;
        if !prefix.is_empty() {
            out.retain(|k| k.starts_with(prefix));
        }
        Ok(out)
    }

    fn size(&self, key: &str) -> FolioResult<u64> {
        let path = self.resolve(key)?;
        Ok(fs::metadata(&path)?.len())
    }

    fn put_path(&self, key: &str, src: &Path) -> FolioResult<()> {
        let dest = self.resolve(key)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, &dest)?;
        Ok(())
    }

    fn local_path(&self, key: &str) -> FolioResult<PathBuf> {
        self.resolve(key)
    }
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) -> FolioResult<()> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk(base, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(base) {
            // Normalize separators to `/` so keys remain portable across
            // platforms — a Windows-written key still reads on Linux.
            let key = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push(key);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_storage() -> (TempDir, LocalStorage) {
        let dir = TempDir::new().unwrap();
        let storage = LocalStorage::new(dir.path()).unwrap();
        (dir, storage)
    }

    // --- validate_key ---

    #[test]
    fn validate_key_accepts_simple_keys() {
        assert!(validate_key("a.epub").is_ok());
        assert!(validate_key("books/abc.epub").is_ok());
        assert!(validate_key("covers/42/cover.jpg").is_ok());
    }

    #[test]
    fn validate_key_rejects_empty() {
        assert!(validate_key("").is_err());
    }

    #[test]
    fn validate_key_rejects_absolute() {
        assert!(validate_key("/books/x").is_err());
        assert!(validate_key("\\books\\x").is_err());
        assert!(validate_key("C:/books/x").is_err());
    }

    #[test]
    fn validate_key_rejects_traversal() {
        assert!(validate_key("../etc/passwd").is_err());
        assert!(validate_key("books/../secret").is_err());
        assert!(validate_key("books/./x").is_err());
    }

    #[test]
    fn validate_key_rejects_empty_segments() {
        assert!(validate_key("books//x").is_err());
        assert!(validate_key("books/").is_err());
    }

    // --- LocalStorage round-trips ---

    #[test]
    fn local_storage_creates_root_if_missing() {
        let parent = TempDir::new().unwrap();
        let root = parent.path().join("does-not-exist-yet");
        assert!(!root.exists());
        let _ = LocalStorage::new(&root).unwrap();
        assert!(root.exists());
    }

    #[test]
    fn put_and_get_round_trip() {
        let (_d, storage) = temp_storage();
        storage.put("a.txt", b"hello").unwrap();
        assert_eq!(storage.get("a.txt").unwrap(), b"hello");
    }

    #[test]
    fn put_creates_nested_dirs() {
        let (_d, storage) = temp_storage();
        storage.put("books/2024/x.epub", b"data").unwrap();
        assert_eq!(storage.get("books/2024/x.epub").unwrap(), b"data");
    }

    #[test]
    fn exists_reports_presence() {
        let (_d, storage) = temp_storage();
        assert!(!storage.exists("nope").unwrap());
        storage.put("here", b"").unwrap();
        assert!(storage.exists("here").unwrap());
    }

    #[test]
    fn delete_removes_object() {
        let (_d, storage) = temp_storage();
        storage.put("gone", b"x").unwrap();
        storage.delete("gone").unwrap();
        assert!(!storage.exists("gone").unwrap());
    }

    #[test]
    fn delete_missing_key_is_noop() {
        let (_d, storage) = temp_storage();
        // Should not error even though nothing is there.
        storage.delete("never-existed").unwrap();
    }

    #[test]
    fn size_returns_byte_length() {
        let (_d, storage) = temp_storage();
        storage.put("k", b"abcdef").unwrap();
        assert_eq!(storage.size("k").unwrap(), 6);
    }

    #[test]
    fn size_missing_key_errors() {
        let (_d, storage) = temp_storage();
        assert!(storage.size("missing").is_err());
    }

    // --- list ---

    #[test]
    fn list_returns_all_keys_when_prefix_empty() {
        let (_d, storage) = temp_storage();
        storage.put("a", b"").unwrap();
        storage.put("b/c", b"").unwrap();
        storage.put("b/d/e", b"").unwrap();
        let mut all = storage.list("").unwrap();
        all.sort();
        assert_eq!(all, vec!["a".to_string(), "b/c".into(), "b/d/e".into()]);
    }

    #[test]
    fn list_filters_by_prefix() {
        let (_d, storage) = temp_storage();
        storage.put("books/a", b"").unwrap();
        storage.put("books/b", b"").unwrap();
        storage.put("covers/c", b"").unwrap();
        let mut books = storage.list("books/").unwrap();
        books.sort();
        assert_eq!(books, vec!["books/a".to_string(), "books/b".into()]);
    }

    #[test]
    fn list_empty_storage_returns_empty_vec() {
        let (_d, storage) = temp_storage();
        assert!(storage.list("").unwrap().is_empty());
    }

    // --- put_path ---

    #[test]
    fn put_path_copies_from_filesystem() {
        let (_d, storage) = temp_storage();
        let src_dir = TempDir::new().unwrap();
        let src = src_dir.path().join("src.epub");
        fs::write(&src, b"book bytes").unwrap();
        storage.put_path("books/x.epub", &src).unwrap();
        assert_eq!(storage.get("books/x.epub").unwrap(), b"book bytes");
    }

    #[test]
    fn put_path_creates_nested_dirs() {
        let (_d, storage) = temp_storage();
        let src_dir = TempDir::new().unwrap();
        let src = src_dir.path().join("src");
        fs::write(&src, b"data").unwrap();
        storage.put_path("deeply/nested/key", &src).unwrap();
        assert!(storage.exists("deeply/nested/key").unwrap());
    }

    // --- local_path ---

    #[test]
    fn local_path_returns_resolved_path() {
        let (d, storage) = temp_storage();
        let p = storage.local_path("books/x.epub").unwrap();
        assert_eq!(p, d.path().join("books").join("x.epub"));
    }

    #[test]
    fn local_path_rejects_traversal() {
        let (_d, storage) = temp_storage();
        assert!(storage.local_path("../escape").is_err());
    }

    // --- invalid keys ---

    #[test]
    fn put_rejects_invalid_key() {
        let (_d, storage) = temp_storage();
        assert!(storage.put("../escape", b"x").is_err());
        assert!(storage.put("", b"x").is_err());
    }

    #[test]
    fn get_rejects_invalid_key() {
        let (_d, storage) = temp_storage();
        assert!(storage.get("/abs").is_err());
    }

    // --- trait object usability ---

    #[test]
    fn storage_is_usable_as_trait_object() {
        let (_d, storage) = temp_storage();
        let dyn_storage: &dyn Storage = &storage;
        dyn_storage.put("k", b"v").unwrap();
        assert_eq!(dyn_storage.get("k").unwrap(), b"v");
    }
}
