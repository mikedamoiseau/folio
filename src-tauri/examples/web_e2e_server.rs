//! Deterministic seeded harness for the Playwright e2e suite (`e2e/`).
//!
//! Boots the embedded web server (`folio_lib::web_server`) against a fresh
//! temp on-disk SQLite DB seeded with a fixed fixture set, so the specs in
//! `e2e/` can assert exact numbers instead of resilient "at least one"
//! checks against a live, hand-curated library.
//!
//! This file is an example target of the `folio` package, compiled as an
//! external crate against the `folio_lib` library (see `[lib] name =
//! "folio_lib"` in `src-tauri/Cargo.toml`) — everything below goes through
//! `folio_lib`'s public API, the same surface `src-tauri/src/main.rs` uses.
//!
//! Run directly: `cargo run --example web_e2e_server` (from `src-tauri/`).
//! `e2e/playwright.config.ts`'s `webServer` block runs this automatically
//! and polls `/api/health` until it responds.
//!
//! ## Fixture set (numbers referenced directly by e2e specs — keep in sync)
//!
//! - 130 books, ids `e2e-book-001`..`e2e-book-130`, titles `Book 001`..
//!   `Book 130`. `added_at` increases with the numeric suffix, so the
//!   default `ORDER BY added_at DESC, id` (see `folio-core/src/db.rs`'s
//!   `list_books_grid`) puts `Book 130` first and `Book 001` last:
//!     - page 1 (offset 0,   limit 60) = Book 130 .. Book 071
//!     - page 2 (offset 60,  limit 60) = Book 070 .. Book 011
//!     - page 3 (offset 120, limit 60) = Book 010 .. Book 001 (10 books)
//! - `Book 099` and `Book 100` share an identical `added_at` to exercise
//!   the `id` ASC tiebreaker: with equal timestamps, `e2e-book-099` sorts
//!   before `e2e-book-100` even though 100 > 99.
//! - 12 books have reading progress (`chapter_index = 4`,
//!   `total_chapters = 10`, i.e. a 50% fill): `Book 005, 015, 025, 035,
//!   045, 055, 065, 075, 085, 095, 105, 115`. Each satisfies
//!   `chapter_index < total_chapters - 1`, so all 12 also qualify for the
//!   "Continue Reading" shelf (`db::get_continue_reading_books`). `Book
//!   075` falls on page 1 of the default grid *and* in the shelf, for the
//!   shelf/grid fill-percentage agreement check.
//! - `Book 060` has `total_chapters = 0` but a progress row
//!   (`chapter_index = 3`) — the UI must render no progress bar for it,
//!   and it's excluded from the "Continue Reading" shelf by the
//!   `total_chapters > 0` guard in `get_continue_reading_books`.
//! - `Book 130` is a CBZ with a real 2-page zip file on disk (2 tiny valid
//!   PNGs), seeded as a linked (`is_imported = false`) book with an
//!   absolute `file_path` so `WebState::resolve_book_path` returns it
//!   unchanged — no library-folder resolution needed.
//! - Every other book is `is_imported = false` with a fake, nonexistent
//!   relative `file_path`; that's fine since nothing beyond the grid/
//!   detail metadata is exercised for them (a missing cover 404s and the
//!   client falls back to its placeholder).

use folio_lib::db;
use folio_lib::models::{Book, BookFormat, ReadingProgress};
use folio_lib::web_server::{self, auth, ServerModes, WebState};
use std::collections::HashMap;
use std::error::Error;
use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Base timestamp (seconds since epoch); book `n`'s `added_at` is this plus
/// `n * 100`, giving every book a distinct, strictly increasing value.
const BASE_TS: i64 = 1_700_000_000;

/// Numeric suffixes of the 12 books seeded with reading progress.
const PROGRESS_NS: [u32; 12] = [5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 105, 115];

/// `Book 060` — has `total_chapters = 0` plus a progress row; must render
/// no progress bar anywhere.
const ZERO_CHAPTERS_N: u32 = 60;

/// `Book 130` — the CBZ book with a real file on disk.
const CBZ_N: u32 = 130;

/// `Book 099` / `Book 100` share an `added_at` to exercise the `id`
/// tiebreaker in the default sort.
const TIE_LOW_N: u32 = 99;
const TIE_HIGH_N: u32 = 100;

const TOTAL_BOOKS: u32 = 130;

fn added_at_for(n: u32) -> i64 {
    BASE_TS + i64::from(n) * 100
}

fn book_id(n: u32) -> String {
    format!("e2e-book-{n:03}")
}

/// Writes a tiny, valid 2-page CBZ (a zip of 2 real PNGs) to `path`.
fn build_test_cbz(path: &Path) -> Result<(), Box<dyn Error>> {
    let file = std::fs::File::create(path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();

    for i in 1..=2u32 {
        let img =
            image::RgbImage::from_pixel(4, 4, image::Rgb([i as u8 * 40, 0, 255 - i as u8 * 40]));
        let mut png_bytes = Vec::new();
        {
            use image::ImageEncoder;
            let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
            encoder.write_image(img.as_raw(), 4, 4, image::ExtendedColorType::Rgb8)?;
        }
        zip.start_file(format!("page{i:02}.png"), options)?;
        zip.write_all(&png_bytes)?;
    }
    zip.finish()?;
    Ok(())
}

fn new_book(n: u32, cbz_path: &Path) -> Book {
    let id = book_id(n);
    let is_cbz = n == CBZ_N;
    let added_at = if n == TIE_HIGH_N {
        added_at_for(TIE_LOW_N)
    } else {
        added_at_for(n)
    };

    Book {
        title: format!("Book {n:03}"),
        author: format!("Author {n:03}"),
        file_path: if is_cbz {
            cbz_path.to_string_lossy().to_string()
        } else {
            format!("{id}.epub")
        },
        cover_path: None,
        total_chapters: if n == ZERO_CHAPTERS_N {
            0
        } else if is_cbz {
            2
        } else {
            10
        },
        added_at,
        format: if is_cbz {
            BookFormat::Cbz
        } else {
            BookFormat::Epub
        },
        file_hash: None,
        description: None,
        genres: None,
        rating: None,
        isbn: None,
        openlibrary_key: None,
        enrichment_status: None,
        series: None,
        volume: None,
        language: None,
        publisher: None,
        publish_year: None,
        is_imported: false,
        id,
    }
}

fn seed(conn: &rusqlite::Connection, cbz_path: &Path) -> Result<(), Box<dyn Error>> {
    for n in 1..=TOTAL_BOOKS {
        let book = new_book(n, cbz_path);
        let added_at = book.added_at;
        db::insert_book(conn, &book)?;

        let progress_chapter_index = if n == ZERO_CHAPTERS_N {
            Some(3)
        } else if PROGRESS_NS.contains(&n) {
            Some(4)
        } else {
            None
        };

        if let Some(chapter_index) = progress_chapter_index {
            db::upsert_reading_progress(
                conn,
                &ReadingProgress {
                    book_id: book.id,
                    chapter_index,
                    scroll_position: 0.0,
                    last_read_at: added_at,
                },
            )?;
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async_main())
}

async fn async_main() -> Result<(), Box<dyn Error>> {
    // Kept alive for the process lifetime — the harness never cleans up
    // its own temp dir (Playwright/CI kill the process instead), matching
    // how other ephemeral e2e fixtures are handled.
    let tempdir = tempfile::Builder::new().prefix("folio-e2e-").tempdir()?;

    let db_path = tempdir.path().join("library.db");
    let data_dir = tempdir.path().join("appdata");
    std::fs::create_dir_all(&data_dir)?;

    let cbz_path = tempdir.path().join("test-book.cbz");
    build_test_cbz(&cbz_path)?;

    let pool = db::create_pool(&db_path)?;
    {
        let conn = pool.get()?;
        seed(&conn, &cbz_path)?;
    }

    let state = WebState {
        pool: Arc::new(Mutex::new(pool)),
        data_dir,
        pin_hash: Arc::new(Mutex::new(None)),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        login_limiter: Arc::new(auth::RateLimiter::new(5, 300)),
    };

    let router = web_server::build_router(
        state,
        ServerModes {
            web_ui: true,
            opds: false,
        },
    );

    let port: u16 = std::env::var("FOLIO_E2E_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7810);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    // Printed AFTER binding so a reader watching stdout knows the port is
    // actually open. Playwright's own readiness check polls the
    // `webServer.url` over HTTP rather than parsing this line, but it's
    // useful for local debugging.
    println!("listening on http://127.0.0.1:{port}");
    std::io::stdout().flush().ok();

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    // Keep the guard alive until the (never-returning, in practice) serve
    // future above completes.
    drop(tempdir);
    Ok(())
}
