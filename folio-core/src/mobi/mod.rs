//! MOBI / AZW / AZW3 (KF8) parser backed by libmobi.
//!
//! This module is gated behind the `mobi` cargo feature (on by default).
//! libmobi is dynamically linked (LGPL v3+); the library is located at
//! build time via pkg-config or the `LIBMOBI_INCLUDE_DIR` /
//! `LIBMOBI_LIB_DIR` env vars.
//!
//! Right now the public surface is intentionally minimal — just enough to
//! validate the FFI path end-to-end. Full chapter/cover/image extraction
//! lands in follow-up commits (see ROADMAP #34).

mod ffi;

use std::ffi::{CStr, CString};
use std::path::Path;
use std::ptr;

use crate::error::{FolioError, FolioResult};

/// A parsed MOBI/AZW/AZW3 file. Releases the underlying `MOBIData` on drop.
pub struct MobiBook {
    handle: *mut ffi::MOBIData,
}

// `MOBIData` is owned exclusively by this struct and libmobi functions that
// only read it take `const MOBIData *`. We never share the pointer across
// threads concurrently, but marking `Send` lets callers move the value.
unsafe impl Send for MobiBook {}

impl MobiBook {
    /// Parse a MOBI/AZW/AZW3 file from disk.
    pub fn open(path: &Path) -> FolioResult<Self> {
        let c_path = CString::new(path.as_os_str().to_string_lossy().as_bytes())
            .map_err(|_| FolioError::InvalidInput("MOBI path contained a NUL byte".into()))?;

        // SAFETY: `mobi_init` returns either a valid heap pointer or null.
        // `mobi_load_filename` reads the path string we keep alive until
        // it returns. We free the handle on any error path.
        unsafe {
            let handle = ffi::mobi_init();
            if handle.is_null() {
                return Err(FolioError::Internal(
                    "libmobi failed to allocate MOBIData".into(),
                ));
            }

            let rc = ffi::mobi_load_filename(handle, c_path.as_ptr());
            if rc != ffi::MOBI_RET_MOBI_SUCCESS {
                ffi::mobi_free(handle);
                return Err(FolioError::InvalidInput(format!(
                    "libmobi failed to parse {}: code {}",
                    path.display(),
                    rc
                )));
            }

            Ok(Self { handle })
        }
    }

    /// Title from the EXTH metadata record, preferred over the PalmDB
    /// "name" field because it's always UTF-8 and avoids libmobi's iconv
    /// code path (which crashes on macOS Tahoe arm64 at process exit).
    pub fn title(&self) -> Option<String> {
        // SAFETY: `handle` is valid for the lifetime of `self`;
        // `mobi_meta_get_title` returns either null or a heap-allocated
        // NUL-terminated UTF-8 string that the caller must `free()`.
        unsafe { take_c_string(ffi::mobi_meta_get_title(self.handle)) }
    }

    /// Author from EXTH metadata. Returns `None` when the EXTH record is
    /// missing.
    pub fn author(&self) -> Option<String> {
        // SAFETY: as above, paired with the matching `free()`.
        unsafe { take_c_string(ffi::mobi_meta_get_author(self.handle)) }
    }

    /// Whether the active content is KF8 (AZW3) rather than legacy
    /// Mobipocket. Hybrid files with both halves still report `true` here
    /// because the KF8 half is preferred.
    pub fn is_kf8(&self) -> bool {
        // SAFETY: `handle` is valid for the lifetime of `self`; the
        // function only reads the struct.
        unsafe { ffi::mobi_is_kf8(self.handle) }
    }

    /// File-format version reported by libmobi. Legacy Mobipocket is
    /// version 6; KF8/AZW3 is version 8.
    pub fn file_version(&self) -> usize {
        // SAFETY: as above.
        unsafe { ffi::mobi_get_fileversion(self.handle) }
    }
}

impl Drop for MobiBook {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: `handle` came from `mobi_init` and we haven't freed
            // it elsewhere.
            unsafe { ffi::mobi_free(self.handle) };
            self.handle = ptr::null_mut();
        }
    }
}

/// Consume a heap-allocated C string from libmobi, returning an owned
/// `String` and calling `libc::free` so the memory isn't leaked.
///
/// # Safety
/// `ptr` must be either null or a valid pointer that libmobi produced via
/// `malloc`/`strdup`. Ownership transfers into this function.
unsafe fn take_c_string(ptr: *mut std::os::raw::c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let owned = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    // libmobi allocates with malloc and documents that callers must free
    // the returned buffers. We release it here.
    extern "C" {
        fn free(ptr: *mut std::os::raw::c_void);
    }
    free(ptr as *mut _);
    Some(owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> Option<PathBuf> {
        // The workspace layout puts fixtures in src-tauri/test-fixtures/
        // (gitignored). Folio-core is built from the workspace root, so
        // CARGO_MANIFEST_DIR points to folio-core/.
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src-tauri")
            .join("test-fixtures")
            .join(name);
        path.exists().then_some(path)
    }

    #[test]
    fn opens_legacy_mobi_and_reads_title() {
        let Some(path) = fixture("alice-legacy.mobi") else {
            eprintln!("skipping: alice-legacy.mobi not present");
            return;
        };
        let book = MobiBook::open(&path).expect("open legacy MOBI");
        let title = book.title().expect("read title");
        assert!(
            title.to_lowercase().contains("alice"),
            "expected 'Alice' in title, got {title:?}"
        );
        let author = book.author().expect("read author");
        assert!(
            author.to_lowercase().contains("carroll"),
            "expected 'Carroll' in author, got {author:?}"
        );
        assert!(!book.is_kf8(), "legacy Mobipocket must not be reported as KF8");
        assert_eq!(book.file_version(), 6, "legacy Mobipocket is file version 6");
    }

    #[test]
    fn opens_kf8_mobi_and_reads_title() {
        let Some(path) = fixture("alice.mobi") else {
            eprintln!("skipping: alice.mobi not present");
            return;
        };
        let book = MobiBook::open(&path).expect("open KF8 MOBI");
        let title = book.title().expect("read title");
        assert!(
            title.to_lowercase().contains("alice"),
            "expected 'Alice' in title, got {title:?}"
        );
        let author = book.author().expect("read author");
        assert!(
            author.to_lowercase().contains("carroll"),
            "expected 'Carroll' in author, got {author:?}"
        );
        assert!(book.is_kf8(), "AZW3 file must be detected as KF8");
        assert_eq!(book.file_version(), 8, "AZW3/KF8 is file version 8");
    }
}
