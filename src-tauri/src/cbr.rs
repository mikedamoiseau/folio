// CBR (Comic Book RAR) format support
//
// CBR files are RAR archives containing sequentially-named image files
// (JPEG, PNG, WebP, etc.).  Extracting them requires a native RAR library.
//
// # Enabling full CBR support
//
// Two crates can provide RAR extraction; both need a system library:
//
//   Option A — `compress-tools` (recommended)
//     Wraps libarchive, which supports RAR + many other formats.
//     Install the system library:
//       macOS:  brew install libarchive
//               export PKG_CONFIG_PATH="$(brew --prefix libarchive)/lib/pkgconfig"
//       Linux:  sudo apt install libarchive-dev   (Debian/Ubuntu)
//               sudo dnf install libarchive-devel (Fedora)
//       Windows: download the pre-built binaries from https://libarchive.org/
//     Then add to Cargo.toml:
//       compress-tools = "0.14"
//     And replace the stub functions below with real extraction code.
//
//   Option B — `unrar`
//     Bindings to the official UnRAR library.
//       macOS:  brew install unrar
//       Linux:  sudo apt install libunrar-dev
//     Then add to Cargo.toml:
//       unrar = "0.5"
//
// Until a native library is available, every function returns a descriptive
// Err so the frontend can surface a helpful message to the user.

/// Metadata extracted during CBR import.
pub struct CbrMeta {
    pub title: String,
    pub page_count: u32,
}

/// Try to import a CBR file and return its metadata.
///
/// Returns `Err` until a native RAR library is configured — see the module
/// documentation above for setup instructions.
pub fn import_cbr(path: &str) -> Result<CbrMeta, String> {
    let _ = path;
    Err(
        "CBR support requires libarchive (macOS: brew install libarchive). \
         See src-tauri/src/cbr.rs for full setup instructions."
            .to_string(),
    )
}

/// Return the number of pages in a CBR file.
pub fn get_page_count(path: &str) -> Result<u32, String> {
    let _ = path;
    Err(
        "CBR support requires libarchive (macOS: brew install libarchive). \
         See src-tauri/src/cbr.rs for full setup instructions."
            .to_string(),
    )
}

/// Return the base64-encoded image for the given page index.
///
/// The returned string includes a `data:image/<mime>;base64,` prefix suitable
/// for use directly as an HTML `<img src>` value.
pub fn get_page_image(path: &str, page_index: u32) -> Result<String, String> {
    let _ = (path, page_index);
    Err(
        "CBR support requires libarchive (macOS: brew install libarchive). \
         See src-tauri/src/cbr.rs for full setup instructions."
            .to_string(),
    )
}
