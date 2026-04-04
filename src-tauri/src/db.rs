use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection, Result};
use std::path::Path;
use std::time::Duration;

use crate::models::{
    ActivityEntry, Book, Bookmark, Collection, CollectionRule, CollectionType, CustomFont,
    ReadingProgress, SeriesInfo,
};

pub type DbPool = Pool<SqliteConnectionManager>;

fn run_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            file_path TEXT NOT NULL UNIQUE,
            cover_path TEXT,
            total_chapters INTEGER NOT NULL DEFAULT 0,
            added_at INTEGER NOT NULL,
            format TEXT NOT NULL DEFAULT 'epub'
        );

        -- Ensures existing databases get the unique constraint even if the
        -- table was created before this migration was added.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_books_file_path ON books(file_path);

        CREATE TABLE IF NOT EXISTS reading_progress (
            book_id TEXT PRIMARY KEY,
            chapter_index INTEGER NOT NULL DEFAULT 0,
            scroll_position REAL NOT NULL DEFAULT 0.0,
            last_read_at INTEGER NOT NULL,
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL,
            chapter_index INTEGER NOT NULL,
            scroll_position REAL NOT NULL,
            note TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('manual','automated')),
            icon TEXT,
            color TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS collection_rules (
            id TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            field TEXT NOT NULL,
            operator TEXT NOT NULL,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_collection_rules_collection_id
            ON collection_rules(collection_id);

        CREATE TABLE IF NOT EXISTS book_collections (
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (book_id, collection_id)
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS highlights (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            chapter_index INTEGER NOT NULL,
            text TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#f6c445',
            note TEXT,
            start_offset INTEGER NOT NULL,
            end_offset INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reading_sessions (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            started_at INTEGER NOT NULL,
            duration_secs INTEGER NOT NULL,
            pages_read INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS book_tags (
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (book_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS activity_log (
            id TEXT PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            entity_name TEXT,
            detail TEXT
        );

        CREATE TABLE IF NOT EXISTS custom_fonts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
    ",
    )?;

    // Additive migrations: ALTER TABLE ADD COLUMN fails silently if already exists.
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN format TEXT NOT NULL DEFAULT 'epub';");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN file_hash TEXT;");
    let _ = conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_books_file_hash ON books(file_hash);",
    );

    // OpenLibrary enrichment columns
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN description TEXT;");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN genres TEXT;"); // JSON array
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN rating REAL;");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN isbn TEXT;");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN openlibrary_key TEXT;");

    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN enrichment_status TEXT;");

    // Series / volume / language / publisher / publish_year columns
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN series TEXT;");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN volume INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN language TEXT;");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN publisher TEXT;");
    let _ = conn.execute_batch("ALTER TABLE books ADD COLUMN publish_year INTEGER;");

    // Incremental backup: ensure updated_at columns exist
    let _ =
        conn.execute_batch("ALTER TABLE books ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");
    let _ = conn
        .execute_batch("ALTER TABLE bookmarks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");
    let _ = conn.execute_batch("ALTER TABLE bookmarks ADD COLUMN name TEXT;");
    let _ = conn
        .execute_batch("ALTER TABLE highlights ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");
    // Linked-books: is_imported flag (1 = copied into library, 0 = linked in-place)
    let _ =
        conn.execute_batch("ALTER TABLE books ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 1;");

    // Sync: add deleted_at for soft-delete support
    let _ = conn.execute_batch("ALTER TABLE bookmarks ADD COLUMN deleted_at INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE highlights ADD COLUMN deleted_at INTEGER;");

    // Backfill: set updated_at = added_at or created_at for existing rows
    let _ = conn.execute_batch("UPDATE books SET updated_at = added_at WHERE updated_at = 0;");
    let _ =
        conn.execute_batch("UPDATE bookmarks SET updated_at = created_at WHERE updated_at = 0;");
    let _ =
        conn.execute_batch("UPDATE highlights SET updated_at = created_at WHERE updated_at = 0;");

    // Index on bookmarks.book_id for list_bookmarks() and cascade delete performance
    let _ = conn
        .execute_batch("CREATE INDEX IF NOT EXISTS idx_bookmarks_book_id ON bookmarks(book_id);");

    // Indexes for common lookup patterns
    let _ = conn
        .execute_batch("CREATE INDEX IF NOT EXISTS idx_highlights_book_id ON highlights(book_id);");
    let _ = conn
        .execute_batch("CREATE INDEX IF NOT EXISTS idx_book_tags_book_id ON book_tags(book_id);");
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_id ON reading_sessions(book_id);",
    );
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_reading_progress_book_id ON reading_progress(book_id);",
    );

    // Migration: drop CHECK constraint on collection_rules.field (was limited to a fixed set;
    // now validated in application code so new rule fields don't require schema changes).
    let has_check: bool = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='collection_rules'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|sql| sql.contains("CHECK"))
        .unwrap_or(false);

    if has_check {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS collection_rules_new (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                field TEXT NOT NULL,
                operator TEXT NOT NULL,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO collection_rules_new SELECT * FROM collection_rules;
            DROP TABLE collection_rules;
            ALTER TABLE collection_rules_new RENAME TO collection_rules;",
        )?;
    }

    Ok(())
}

pub fn create_pool(db_path: &Path) -> Result<DbPool, Box<dyn std::error::Error>> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let manager = SqliteConnectionManager::file(db_path)
        .with_init(|conn| conn.execute_batch("PRAGMA foreign_keys = ON;"));

    let pool = Pool::builder()
        .max_size(5)
        .connection_timeout(Duration::from_secs(5))
        .build(manager)?;

    // Run schema migrations on startup using a pool connection.
    let conn = pool.get()?;
    run_schema(&conn)?;

    Ok(pool)
}

/// Opens a single connection used only by tests.
#[cfg(test)]
pub fn init_db(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    run_schema(&conn)?;
    Ok(conn)
}

// --- Book CRUD ---

pub fn insert_book(conn: &Connection, book: &Book) -> Result<()> {
    conn.execute(
        "INSERT INTO books (id, title, author, file_path, cover_path, total_chapters, added_at, format, file_hash, description, genres, rating, isbn, openlibrary_key, updated_at, enrichment_status, series, volume, language, publisher, publish_year, is_imported)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
        params![
            book.id,
            book.title,
            book.author,
            book.file_path,
            book.cover_path,
            book.total_chapters,
            book.added_at,
            book.format.to_string(),
            book.file_hash,
            book.description,
            book.genres,
            book.rating,
            book.isbn,
            book.openlibrary_key,
            book.added_at,
            book.enrichment_status,
            book.series,
            book.volume,
            book.language,
            book.publisher,
            book.publish_year,
            book.is_imported as i32,
        ],
    )?;
    Ok(())
}

pub fn get_book(conn: &Connection, id: &str) -> Result<Option<Book>> {
    let sql = format!("SELECT {} FROM books WHERE id = ?1", BOOK_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_book(row)?))
    } else {
        Ok(None)
    }
}

pub fn get_book_by_file_path(conn: &Connection, file_path: &str) -> Result<Option<Book>> {
    let sql = format!("SELECT {} FROM books WHERE file_path = ?1", BOOK_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![file_path])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_book(row)?))
    } else {
        Ok(None)
    }
}

pub fn get_book_by_file_hash(conn: &Connection, hash: &str) -> Result<Option<Book>> {
    let sql = format!("SELECT {} FROM books WHERE file_hash = ?1", BOOK_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![hash])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_book(row)?))
    } else {
        Ok(None)
    }
}

pub fn list_books(conn: &Connection) -> Result<Vec<Book>> {
    let sql = format!("SELECT {} FROM books ORDER BY added_at DESC", BOOK_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_book)?;
    rows.collect()
}

pub fn update_book(conn: &Connection, book: &Book) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    // file_hash is immutable after import — not included in update
    conn.execute(
        "UPDATE books SET title=?2, author=?3, file_path=?4, cover_path=?5,
         total_chapters=?6, added_at=?7, format=?8,
         description=?9, genres=?10, rating=?11, isbn=?12, openlibrary_key=?13,
         updated_at=?14, series=?15, volume=?16, language=?17, publisher=?18, publish_year=?19
         WHERE id=?1",
        params![
            book.id,
            book.title,
            book.author,
            book.file_path,
            book.cover_path,
            book.total_chapters,
            book.added_at,
            book.format.to_string(),
            book.description,
            book.genres,
            book.rating,
            book.isbn,
            book.openlibrary_key,
            now,
            book.series,
            book.volume,
            book.language,
            book.publisher,
            book.publish_year,
        ],
    )?;
    Ok(())
}

pub fn update_book_path(
    conn: &Connection,
    book_id: &str,
    new_path: &str,
    is_imported: bool,
) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE books SET file_path = ?1, is_imported = ?2, updated_at = ?3 WHERE id = ?4",
        params![new_path, is_imported as i32, now, book_id],
    )?;
    Ok(())
}

pub fn delete_book(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn update_book_enrichment(
    conn: &Connection,
    book_id: &str,
    description: Option<&str>,
    genres: Option<&str>,
    rating: Option<f64>,
    isbn: Option<&str>,
    openlibrary_key: Option<&str>,
) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE books SET description=?2, genres=?3, rating=?4, isbn=?5, openlibrary_key=?6, updated_at=?7 WHERE id=?1",
        params![book_id, description, genres, rating, isbn, openlibrary_key, now],
    )?;
    Ok(())
}

pub fn set_enrichment_status(conn: &Connection, book_id: &str, status: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET enrichment_status = ?2 WHERE id = ?1",
        params![book_id, status],
    )?;
    Ok(())
}

pub fn list_unenriched_books(conn: &Connection) -> Result<Vec<Book>> {
    let sql = format!(
        "SELECT {} FROM books WHERE enrichment_status IS NULL OR enrichment_status = 'queued' ORDER BY added_at DESC",
        BOOK_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_book)?;
    rows.collect()
}

pub fn update_book_file_path(conn: &Connection, book_id: &str, new_path: &str) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE books SET file_path = ?2, updated_at = ?3 WHERE id = ?1",
        params![book_id, new_path, now],
    )?;
    Ok(())
}

// --- Settings ---

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_or_create_device_id(conn: &Connection) -> Result<String> {
    if let Some(id) = get_setting(conn, "device_id")? {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    set_setting(conn, "device_id", &id)?;
    Ok(id)
}

pub fn is_sync_enabled(conn: &Connection) -> bool {
    get_setting(conn, "sync_enabled").ok().flatten().as_deref() == Some("true")
}

// --- ReadingProgress CRUD ---

pub fn upsert_reading_progress(conn: &Connection, progress: &ReadingProgress) -> Result<()> {
    conn.execute(
        "INSERT INTO reading_progress (book_id, chapter_index, scroll_position, last_read_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id) DO UPDATE SET
           chapter_index=excluded.chapter_index,
           scroll_position=excluded.scroll_position,
           last_read_at=excluded.last_read_at",
        params![
            progress.book_id,
            progress.chapter_index,
            progress.scroll_position,
            progress.last_read_at,
        ],
    )?;
    Ok(())
}

pub fn get_reading_progress(conn: &Connection, book_id: &str) -> Result<Option<ReadingProgress>> {
    let mut stmt = conn.prepare(
        "SELECT book_id, chapter_index, scroll_position, last_read_at
         FROM reading_progress WHERE book_id = ?1",
    )?;
    let mut rows = stmt.query(params![book_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(ReadingProgress {
            book_id: row.get(0)?,
            chapter_index: row.get(1)?,
            scroll_position: row.get(2)?,
            last_read_at: row.get(3)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_recently_read_books(conn: &Connection, limit: u32) -> Result<Vec<Book>> {
    let sql = format!(
        "SELECT {} FROM books b JOIN reading_progress rp ON rp.book_id = b.id ORDER BY rp.last_read_at DESC LIMIT ?1",
        BOOK_COLUMNS_B
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit], row_to_book)?;
    rows.collect()
}

// --- Bookmark CRUD ---

pub fn insert_bookmark(conn: &Connection, bookmark: &Bookmark) -> Result<()> {
    conn.execute(
        "INSERT INTO bookmarks (id, book_id, chapter_index, scroll_position, name, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            bookmark.id,
            bookmark.book_id,
            bookmark.chapter_index,
            bookmark.scroll_position,
            bookmark.name,
            bookmark.note,
            bookmark.created_at,
            bookmark.updated_at,
        ],
    )?;
    Ok(())
}

pub fn list_bookmarks(conn: &Connection, book_id: &str) -> Result<Vec<Bookmark>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, scroll_position, name, note, created_at, updated_at, deleted_at
         FROM bookmarks WHERE book_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(Bookmark {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            scroll_position: row.get(3)?,
            name: row.get(4)?,
            note: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            deleted_at: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn delete_bookmark(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn soft_delete_bookmark(conn: &Connection, id: &str) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE bookmarks SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;
    Ok(())
}

pub fn update_bookmark_name(conn: &Connection, id: &str, name: Option<&str>) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE bookmarks SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now, id],
    )?;
    Ok(())
}

// --- Collections CRUD ---

/// Standard column list for SELECT queries on books.
const BOOK_COLUMNS: &str = "id, title, author, file_path, cover_path, total_chapters, added_at, format, file_hash, description, genres, rating, isbn, openlibrary_key, enrichment_status, series, volume, language, publisher, publish_year, is_imported";

/// Standard column list prefixed with table alias `b.`.
const BOOK_COLUMNS_B: &str = "b.id, b.title, b.author, b.file_path, b.cover_path, b.total_chapters, b.added_at, b.format, b.file_hash, b.description, b.genres, b.rating, b.isbn, b.openlibrary_key, b.enrichment_status, b.series, b.volume, b.language, b.publisher, b.publish_year, b.is_imported";

fn row_to_book(row: &rusqlite::Row) -> rusqlite::Result<Book> {
    let format_str: String = row.get(7)?;
    Ok(Book {
        id: row.get(0)?,
        title: row.get(1)?,
        author: row.get(2)?,
        file_path: row.get(3)?,
        cover_path: row.get(4)?,
        total_chapters: row.get(5)?,
        added_at: row.get(6)?,
        format: format_str
            .parse()
            .map_err(|e: String| rusqlite::Error::InvalidParameterName(e))?,
        file_hash: row.get(8)?,
        description: row.get(9)?,
        genres: row.get(10)?,
        rating: row.get(11)?,
        isbn: row.get(12)?,
        openlibrary_key: row.get(13)?,
        enrichment_status: row.get(14)?,
        series: row.get(15)?,
        volume: row.get(16)?,
        language: row.get(17)?,
        publisher: row.get(18)?,
        publish_year: row.get(19)?,
        is_imported: row.get::<_, i32>(20).unwrap_or(1) != 0,
    })
}

pub fn insert_collection(conn: &Connection, collection: &Collection) -> Result<()> {
    let type_str = match collection.r#type {
        CollectionType::Manual => "manual",
        CollectionType::Automated => "automated",
    };
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO collections (id, name, type, icon, color, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            collection.id,
            collection.name,
            type_str,
            collection.icon,
            collection.color,
            collection.created_at,
            collection.updated_at,
        ],
    )?;
    for rule in &collection.rules {
        tx.execute(
            "INSERT INTO collection_rules (id, collection_id, field, operator, value)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                rule.id,
                rule.collection_id,
                rule.field,
                rule.operator,
                rule.value
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn update_collection(conn: &Connection, collection: &Collection) -> Result<()> {
    let type_str = match collection.r#type {
        CollectionType::Manual => "manual",
        CollectionType::Automated => "automated",
    };
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE collections SET name = ?1, type = ?2, icon = ?3, color = ?4, updated_at = ?5
         WHERE id = ?6",
        params![
            collection.name,
            type_str,
            collection.icon,
            collection.color,
            collection.updated_at,
            collection.id,
        ],
    )?;
    tx.execute(
        "DELETE FROM collection_rules WHERE collection_id = ?1",
        params![collection.id],
    )?;
    for rule in &collection.rules {
        tx.execute(
            "INSERT INTO collection_rules (id, collection_id, field, operator, value)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                rule.id,
                rule.collection_id,
                rule.field,
                rule.operator,
                rule.value
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn get_collection_rules(conn: &Connection, collection_id: &str) -> Result<Vec<CollectionRule>> {
    let mut stmt = conn.prepare(
        "SELECT id, collection_id, field, operator, value
         FROM collection_rules WHERE collection_id = ?1",
    )?;
    let rows = stmt.query_map(params![collection_id], |row| {
        Ok(CollectionRule {
            id: row.get(0)?,
            collection_id: row.get(1)?,
            field: row.get(2)?,
            operator: row.get(3)?,
            value: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn list_collections(conn: &Connection) -> Result<Vec<Collection>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, type, icon, color, created_at, updated_at
         FROM collections ORDER BY created_at ASC",
    )?;
    let collections: Vec<Collection> = stmt
        .query_map([], |row| {
            let type_str: String = row.get(2)?;
            let coll_type = match type_str.as_str() {
                "automated" => CollectionType::Automated,
                _ => CollectionType::Manual,
            };
            Ok(Collection {
                id: row.get(0)?,
                name: row.get(1)?,
                r#type: coll_type,
                icon: row.get(3)?,
                color: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                rules: vec![],
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    // Fetch ALL rules in one query instead of N+1 per-collection queries.
    let mut rules_stmt =
        conn.prepare("SELECT id, collection_id, field, operator, value FROM collection_rules")?;
    let all_rules: Vec<CollectionRule> = rules_stmt
        .query_map([], |row| {
            Ok(CollectionRule {
                id: row.get(0)?,
                collection_id: row.get(1)?,
                field: row.get(2)?,
                operator: row.get(3)?,
                value: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    // Group rules by collection_id
    let mut rules_map: std::collections::HashMap<String, Vec<CollectionRule>> =
        std::collections::HashMap::new();
    for rule in all_rules {
        rules_map
            .entry(rule.collection_id.clone())
            .or_default()
            .push(rule);
    }

    let result = collections
        .into_iter()
        .map(|mut coll| {
            coll.rules = rules_map.remove(&coll.id).unwrap_or_default();
            coll
        })
        .collect();
    Ok(result)
}

pub fn delete_collection(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn add_book_to_collection(conn: &Connection, book_id: &str, collection_id: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO book_collections (book_id, collection_id, added_at)
         VALUES (?1, ?2, unixepoch())",
        params![book_id, collection_id],
    )?;
    Ok(())
}

pub fn remove_book_from_collection(
    conn: &Connection,
    book_id: &str,
    collection_id: &str,
) -> Result<()> {
    conn.execute(
        "DELETE FROM book_collections WHERE book_id = ?1 AND collection_id = ?2",
        params![book_id, collection_id],
    )?;
    Ok(())
}

// --- Reading Sessions ---

pub fn insert_reading_session(
    conn: &Connection,
    id: &str,
    book_id: &str,
    started_at: i64,
    duration_secs: i64,
    pages_read: i32,
) -> Result<()> {
    conn.execute(
        "INSERT INTO reading_sessions (id, book_id, started_at, duration_secs, pages_read)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, book_id, started_at, duration_secs, pages_read],
    )?;
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStats {
    pub total_reading_time_secs: i64,
    pub total_sessions: i64,
    pub total_pages_read: i64,
    pub books_finished: i64,
    pub current_streak_days: i64,
    pub longest_streak_days: i64,
    pub daily_reading: Vec<(String, i64)>, // (date_str, seconds)
}

pub fn get_reading_stats(conn: &Connection) -> Result<ReadingStats> {
    let total_reading_time_secs: i64 = conn.query_row(
        "SELECT COALESCE(SUM(duration_secs), 0) FROM reading_sessions",
        [],
        |row| row.get(0),
    )?;
    let total_sessions: i64 =
        conn.query_row("SELECT COUNT(*) FROM reading_sessions", [], |row| {
            row.get(0)
        })?;
    let total_pages_read: i64 = conn.query_row(
        "SELECT COALESCE(SUM(pages_read), 0) FROM reading_sessions",
        [],
        |row| row.get(0),
    )?;
    let books_finished: i64 = conn.query_row(
        "SELECT COUNT(*) FROM reading_progress rp JOIN books b ON rp.book_id = b.id WHERE rp.chapter_index >= b.total_chapters - 1",
        [],
        |row| row.get(0),
    )?;

    // Daily reading for last 30 days
    let mut stmt = conn.prepare(
        "SELECT date(started_at, 'unixepoch', 'localtime') as day, SUM(duration_secs)
         FROM reading_sessions
         WHERE started_at > strftime('%s', 'now', '-30 days')
         GROUP BY day ORDER BY day ASC",
    )?;
    let daily_reading: Vec<(String, i64)> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    // Calculate streaks from daily data
    let streak_days: Vec<String> = conn.prepare(
        "SELECT DISTINCT date(started_at, 'unixepoch', 'localtime') as day FROM reading_sessions ORDER BY day DESC",
    )?.query_map([], |row| row.get::<_, String>(0))?.filter_map(|r| r.ok()).collect();

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut current_streak = 0i64;
    let mut longest_streak = 0i64;
    let mut running_streak = 0i64;
    let mut expected_date = today.clone();

    for day in &streak_days {
        if *day == expected_date {
            running_streak += 1;
            // Move expected_date back one day
            if let Ok(d) = chrono::NaiveDate::parse_from_str(&expected_date, "%Y-%m-%d") {
                expected_date = (d - chrono::Duration::days(1))
                    .format("%Y-%m-%d")
                    .to_string();
            }
        } else {
            if current_streak == 0 {
                current_streak = running_streak;
            }
            if running_streak > longest_streak {
                longest_streak = running_streak;
            }
            running_streak = 0;
            // Reset: check if this day starts a new streak
            if let Ok(d) = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d") {
                expected_date = (d - chrono::Duration::days(1))
                    .format("%Y-%m-%d")
                    .to_string();
                running_streak = 1;
            }
        }
    }
    if current_streak == 0 {
        current_streak = running_streak;
    }
    if running_streak > longest_streak {
        longest_streak = running_streak;
    }

    Ok(ReadingStats {
        total_reading_time_secs,
        total_sessions,
        total_pages_read,
        books_finished,
        current_streak_days: current_streak,
        longest_streak_days: longest_streak,
        daily_reading,
    })
}

// --- Highlights CRUD ---

pub fn insert_highlight(conn: &Connection, h: &crate::models::Highlight) -> Result<()> {
    conn.execute(
        "INSERT INTO highlights (id, book_id, chapter_index, text, color, note, start_offset, end_offset, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![h.id, h.book_id, h.chapter_index, h.text, h.color, h.note, h.start_offset, h.end_offset, h.created_at, h.updated_at],
    )?;
    Ok(())
}

pub fn list_highlights(conn: &Connection, book_id: &str) -> Result<Vec<crate::models::Highlight>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, text, color, note, start_offset, end_offset, created_at, updated_at, deleted_at
         FROM highlights WHERE book_id = ?1 AND deleted_at IS NULL ORDER BY chapter_index ASC, start_offset ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(crate::models::Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            text: row.get(3)?,
            color: row.get(4)?,
            note: row.get(5)?,
            start_offset: row.get(6)?,
            end_offset: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn get_chapter_highlights(
    conn: &Connection,
    book_id: &str,
    chapter_index: u32,
) -> Result<Vec<crate::models::Highlight>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, text, color, note, start_offset, end_offset, created_at, updated_at, deleted_at
         FROM highlights WHERE book_id = ?1 AND chapter_index = ?2 AND deleted_at IS NULL ORDER BY start_offset ASC",
    )?;
    let rows = stmt.query_map(params![book_id, chapter_index], |row| {
        Ok(crate::models::Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            text: row.get(3)?,
            color: row.get(4)?,
            note: row.get(5)?,
            start_offset: row.get(6)?,
            end_offset: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn update_highlight_note(conn: &Connection, id: &str, note: Option<&str>) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE highlights SET note = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, note, now],
    )?;
    Ok(())
}

pub fn delete_highlight(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn soft_delete_highlight(conn: &Connection, id: &str) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE highlights SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![now, id],
    )?;
    Ok(())
}

// --- Sync-inclusive queries ---

pub fn list_all_bookmarks_for_sync(conn: &Connection, book_id: &str) -> Result<Vec<Bookmark>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, scroll_position, name, note, created_at, updated_at, deleted_at
         FROM bookmarks WHERE book_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(Bookmark {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            scroll_position: row.get(3)?,
            name: row.get(4)?,
            note: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            deleted_at: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn list_all_highlights_for_sync(
    conn: &Connection,
    book_id: &str,
) -> Result<Vec<crate::models::Highlight>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, text, color, note, start_offset, end_offset, created_at, updated_at, deleted_at
         FROM highlights WHERE book_id = ?1 ORDER BY chapter_index ASC, start_offset ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(crate::models::Highlight {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            text: row.get(3)?,
            color: row.get(4)?,
            note: row.get(5)?,
            start_offset: row.get(6)?,
            end_offset: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn upsert_bookmark_from_sync(conn: &Connection, bookmark: &Bookmark) -> Result<()> {
    conn.execute(
        "INSERT INTO bookmarks (id, book_id, chapter_index, scroll_position, name, note, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           book_id=excluded.book_id,
           chapter_index=excluded.chapter_index,
           scroll_position=excluded.scroll_position,
           name=excluded.name,
           note=excluded.note,
           created_at=excluded.created_at,
           updated_at=excluded.updated_at,
           deleted_at=excluded.deleted_at",
        params![
            bookmark.id,
            bookmark.book_id,
            bookmark.chapter_index,
            bookmark.scroll_position,
            bookmark.name,
            bookmark.note,
            bookmark.created_at,
            bookmark.updated_at,
            bookmark.deleted_at,
        ],
    )?;
    Ok(())
}

pub fn upsert_highlight_from_sync(conn: &Connection, h: &crate::models::Highlight) -> Result<()> {
    conn.execute(
        "INSERT INTO highlights (id, book_id, chapter_index, text, color, note, start_offset, end_offset, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           book_id=excluded.book_id,
           chapter_index=excluded.chapter_index,
           text=excluded.text,
           color=excluded.color,
           note=excluded.note,
           start_offset=excluded.start_offset,
           end_offset=excluded.end_offset,
           created_at=excluded.created_at,
           updated_at=excluded.updated_at,
           deleted_at=excluded.deleted_at",
        params![
            h.id,
            h.book_id,
            h.chapter_index,
            h.text,
            h.color,
            h.note,
            h.start_offset,
            h.end_offset,
            h.created_at,
            h.updated_at,
            h.deleted_at,
        ],
    )?;
    Ok(())
}

// --- Tags CRUD ---

pub fn list_tags(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT id, name FROM tags ORDER BY name ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

pub fn get_or_create_tag(conn: &Connection, tag_id: &str, name: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO tags (id, name) VALUES (?1, ?2)",
        params![tag_id, name],
    )?;
    Ok(())
}

pub fn get_tag_by_name(conn: &Connection, name: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT id FROM tags WHERE name = ?1")?;
    let mut rows = stmt.query(params![name])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn add_tag_to_book(conn: &Connection, book_id: &str, tag_id: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?1, ?2)",
        params![book_id, tag_id],
    )?;
    Ok(())
}

pub fn remove_tag_from_book(conn: &Connection, book_id: &str, tag_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM book_tags WHERE book_id = ?1 AND tag_id = ?2",
        params![book_id, tag_id],
    )?;
    Ok(())
}

pub fn get_book_tags(conn: &Connection, book_id: &str) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name FROM tags t
         JOIN book_tags bt ON bt.tag_id = t.id
         WHERE bt.book_id = ?1
         ORDER BY t.name ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

pub fn delete_tag(conn: &Connection, tag_id: &str) -> Result<()> {
    conn.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])?;
    Ok(())
}

pub fn get_books_in_collection(conn: &Connection, collection_id: &str) -> Result<Vec<Book>> {
    let mut type_stmt = conn.prepare("SELECT type FROM collections WHERE id = ?1")?;
    let coll_type: String = type_stmt.query_row(params![collection_id], |row| row.get(0))?;

    if coll_type == "manual" {
        let sql = format!(
            "SELECT {} FROM books b JOIN book_collections bc ON bc.book_id = b.id WHERE bc.collection_id = ?1 ORDER BY bc.added_at DESC",
            BOOK_COLUMNS_B
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![collection_id], row_to_book)?;
        return rows.collect();
    }

    // Automated: build a dynamic parameterized query from collection rules.
    let rules = get_collection_rules(conn, collection_id)?;
    let (joins, where_str, param_values) = build_rule_query(&rules);

    let sql = format!(
        "SELECT DISTINCT {cols}
         FROM books b
         {joins}
         {where_str}
         ORDER BY b.added_at DESC",
        cols = BOOK_COLUMNS_B
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(param_values.iter()), row_to_book)?;
    rows.collect()
}

/// Build JOIN, WHERE, and parameter lists from a set of collection rules.
fn build_rule_query(rules: &[CollectionRule]) -> (String, String, Vec<String>) {
    let mut join_clauses: Vec<String> = Vec::new();
    let mut where_clauses: Vec<String> = Vec::new();
    let mut param_values: Vec<String> = Vec::new();
    let mut rp_idx: u32 = 0;
    let mut tag_idx: u32 = 0;

    for rule in rules {
        match (rule.field.as_str(), rule.operator.as_str()) {
            ("author", "contains") => {
                where_clauses.push("b.author LIKE ?".to_string());
                param_values.push(format!("%{}%", rule.value));
            }
            ("filename", "contains") => {
                where_clauses.push("b.title LIKE ?".to_string());
                param_values.push(format!("%{}%", rule.value));
            }
            ("series", "contains") => {
                where_clauses.push("b.series LIKE ?".to_string());
                param_values.push(format!("%{}%", rule.value));
            }
            ("series", "equals") => {
                where_clauses.push("b.series = ?".to_string());
                param_values.push(rule.value.clone());
            }
            ("language", "equals") => {
                where_clauses.push("b.language = ?".to_string());
                param_values.push(rule.value.clone());
            }
            ("language", "contains") => {
                where_clauses.push("b.language LIKE ?".to_string());
                param_values.push(format!("%{}%", rule.value));
            }
            ("publisher", "contains") => {
                where_clauses.push("b.publisher LIKE ?".to_string());
                param_values.push(format!("%{}%", rule.value));
            }
            ("description", "contains") => {
                where_clauses.push("b.description LIKE ?".to_string());
                param_values.push(format!("%{}%", rule.value));
            }
            ("format", "equals") => {
                where_clauses.push("b.format = ?".to_string());
                param_values.push(rule.value.clone());
            }
            ("date_added", "last_n_days") => {
                where_clauses.push(
                    "b.added_at > (strftime('%s', 'now') - CAST(? AS INTEGER) * 86400)".to_string(),
                );
                param_values.push(rule.value.clone());
            }
            ("tag", "contains") => {
                tag_idx += 1;
                let bt = format!("bt{tag_idx}");
                let tt = format!("tt{tag_idx}");
                join_clauses.push(format!(
                    "JOIN book_tags {bt} ON {bt}.book_id = b.id \
                     JOIN tags {tt} ON {tt}.id = {bt}.tag_id AND {tt}.name LIKE ?"
                ));
                param_values.push(format!("%{}%", rule.value));
            }
            ("tag", "equals") => {
                tag_idx += 1;
                let bt = format!("bt{tag_idx}");
                let tt = format!("tt{tag_idx}");
                join_clauses.push(format!(
                    "JOIN book_tags {bt} ON {bt}.book_id = b.id \
                     JOIN tags {tt} ON {tt}.id = {bt}.tag_id AND {tt}.name = ?"
                ));
                param_values.push(rule.value.clone());
            }
            ("reading_progress", "equals") => {
                rp_idx += 1;
                let alias = format!("rp{rp_idx}");
                match rule.value.as_str() {
                    "unread" => {
                        join_clauses.push(format!(
                            "LEFT JOIN reading_progress {alias} ON {alias}.book_id = b.id"
                        ));
                        where_clauses.push(format!("{alias}.book_id IS NULL"));
                    }
                    "in_progress" => {
                        join_clauses.push(format!(
                            "JOIN reading_progress {alias} ON {alias}.book_id = b.id"
                        ));
                        where_clauses.push(format!("{alias}.chapter_index < b.total_chapters - 1"));
                    }
                    "finished" => {
                        join_clauses.push(format!(
                            "JOIN reading_progress {alias} ON {alias}.book_id = b.id"
                        ));
                        where_clauses
                            .push(format!("{alias}.chapter_index >= b.total_chapters - 1"));
                    }
                    _ => {}
                }
            }
            _ => {} // unrecognised rule — skip
        }
    }

    let joins = join_clauses.join(" ");
    let where_str = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    };

    (joins, where_str, param_values)
}

/// Preview how many books match a set of rules without persisting a collection.
pub fn preview_collection_rules(
    conn: &Connection,
    rules: &[crate::models::NewRuleInput],
) -> Result<usize> {
    use crate::models::CollectionRule;
    let converted: Vec<CollectionRule> = rules
        .iter()
        .map(|r| CollectionRule {
            id: String::new(),
            collection_id: String::new(),
            field: r.field.clone(),
            operator: r.operator.clone(),
            value: r.value.clone(),
        })
        .collect();
    let (joins, where_str, param_values) = build_rule_query(&converted);

    let sql = format!(
        "SELECT COUNT(DISTINCT b.id)
         FROM books b
         {joins}
         {where_str}"
    );

    let mut stmt = conn.prepare(&sql)?;
    let count: usize = stmt.query_row(rusqlite::params_from_iter(param_values.iter()), |row| {
        row.get(0)
    })?;
    Ok(count)
}

// --- Activity log ---

pub fn insert_activity(conn: &Connection, entry: &ActivityEntry) -> Result<()> {
    conn.execute(
        "INSERT INTO activity_log (id, timestamp, action, entity_type, entity_id, entity_name, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![entry.id, entry.timestamp, entry.action, entry.entity_type, entry.entity_id, entry.entity_name, entry.detail],
    )?;
    Ok(())
}

pub fn get_activity_log(
    conn: &Connection,
    limit: u32,
    offset: u32,
    action_filter: Option<&str>,
) -> Result<Vec<ActivityEntry>> {
    let (sql, filter_params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(action) =
        action_filter
    {
        (
                "SELECT id, timestamp, action, entity_type, entity_id, entity_name, detail FROM activity_log WHERE action = ?1 ORDER BY timestamp DESC LIMIT ?2 OFFSET ?3".to_string(),
                vec![
                    Box::new(action.to_string()) as Box<dyn rusqlite::types::ToSql>,
                    Box::new(limit),
                    Box::new(offset),
                ],
            )
    } else {
        (
                "SELECT id, timestamp, action, entity_type, entity_id, entity_name, detail FROM activity_log ORDER BY timestamp DESC LIMIT ?1 OFFSET ?2".to_string(),
                vec![
                    Box::new(limit) as Box<dyn rusqlite::types::ToSql>,
                    Box::new(offset),
                ],
            )
    };

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> =
        filter_params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(ActivityEntry {
            id: row.get(0)?,
            timestamp: row.get(1)?,
            action: row.get(2)?,
            entity_type: row.get(3)?,
            entity_id: row.get(4)?,
            entity_name: row.get(5)?,
            detail: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn prune_activity_log(conn: &Connection, keep: u32) -> Result<()> {
    let cutoff = chrono::Utc::now().timestamp() - 90 * 24 * 60 * 60;
    conn.execute(
        "DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY timestamp DESC LIMIT ?1) AND timestamp < ?2",
        params![keep, cutoff],
    )?;
    Ok(())
}

pub fn insert_custom_font(conn: &Connection, font: &CustomFont) -> Result<()> {
    conn.execute(
        "INSERT INTO custom_fonts (id, name, file_name, file_path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            font.id,
            font.name,
            font.file_name,
            font.file_path,
            font.created_at
        ],
    )?;
    Ok(())
}

pub fn list_custom_fonts(conn: &Connection) -> Result<Vec<CustomFont>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, file_name, file_path, created_at
         FROM custom_fonts ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(CustomFont {
            id: row.get(0)?,
            name: row.get(1)?,
            file_name: row.get(2)?,
            file_path: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn delete_custom_font(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM custom_fonts WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_custom_font(conn: &Connection, id: &str) -> Result<Option<CustomFont>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, file_name, file_path, created_at
         FROM custom_fonts WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(CustomFont {
            id: row.get(0)?,
            name: row.get(1)?,
            file_name: row.get(2)?,
            file_path: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    rows.next().transpose()
}

pub fn list_series(conn: &Connection) -> Result<Vec<SeriesInfo>> {
    let mut stmt = conn.prepare(
        "SELECT series, COUNT(*) as count FROM books
         WHERE series IS NOT NULL AND series != ''
         GROUP BY series HAVING count >= 2
         ORDER BY series ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SeriesInfo {
            name: row.get(0)?,
            count: row.get(1)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BookFormat;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = init_db(&db_path).unwrap();
        (dir, conn)
    }

    fn sample_book(id: &str) -> Book {
        Book {
            id: id.to_string(),
            title: "Test Book".to_string(),
            author: "Test Author".to_string(),
            file_path: "/tmp/test.epub".to_string(),
            cover_path: None,
            total_chapters: 10,
            added_at: 1700000000,
            format: BookFormat::Epub,
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
            is_imported: true,
        }
    }

    #[test]
    fn test_book_crud() {
        let (_dir, conn) = setup();
        let book = sample_book("book-1");

        insert_book(&conn, &book).unwrap();

        let fetched = get_book(&conn, "book-1").unwrap().unwrap();
        assert_eq!(fetched.title, "Test Book");
        assert_eq!(fetched.author, "Test Author");

        let books = list_books(&conn).unwrap();
        assert_eq!(books.len(), 1);

        let updated = Book {
            title: "Updated Title".to_string(),
            ..book
        };
        update_book(&conn, &updated).unwrap();
        let fetched2 = get_book(&conn, "book-1").unwrap().unwrap();
        assert_eq!(fetched2.title, "Updated Title");

        delete_book(&conn, "book-1").unwrap();
        assert!(get_book(&conn, "book-1").unwrap().is_none());
    }

    #[test]
    fn test_reading_progress_upsert() {
        let (_dir, conn) = setup();
        let book = sample_book("book-2");
        insert_book(&conn, &book).unwrap();

        let progress = ReadingProgress {
            book_id: "book-2".to_string(),
            chapter_index: 3,
            scroll_position: 0.5,
            last_read_at: 1700000100,
        };
        upsert_reading_progress(&conn, &progress).unwrap();

        let fetched = get_reading_progress(&conn, "book-2").unwrap().unwrap();
        assert_eq!(fetched.chapter_index, 3);
        assert!((fetched.scroll_position - 0.5).abs() < f64::EPSILON);

        let updated = ReadingProgress {
            chapter_index: 5,
            scroll_position: 0.8,
            ..progress
        };
        upsert_reading_progress(&conn, &updated).unwrap();
        let fetched2 = get_reading_progress(&conn, "book-2").unwrap().unwrap();
        assert_eq!(fetched2.chapter_index, 5);
    }

    #[test]
    fn test_duplicate_file_path_rejected() {
        let (_dir, conn) = setup();
        let book = sample_book("book-dup");
        insert_book(&conn, &book).unwrap();

        // Second insert with same file_path must fail.
        let duplicate = Book {
            id: "book-dup-2".to_string(),
            ..book
        };
        assert!(insert_book(&conn, &duplicate).is_err());
    }

    #[test]
    fn test_get_book_by_file_path() {
        let (_dir, conn) = setup();
        let book = sample_book("book-fp");
        insert_book(&conn, &book).unwrap();

        let found = get_book_by_file_path(&conn, "/tmp/test.epub").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, "book-fp");

        let missing = get_book_by_file_path(&conn, "/tmp/missing.epub").unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn test_bookmark_crud() {
        let (_dir, conn) = setup();
        let book = sample_book("book-3");
        insert_book(&conn, &book).unwrap();

        let bookmark = Bookmark {
            id: "bm-1".to_string(),
            book_id: "book-3".to_string(),
            chapter_index: 2,
            scroll_position: 0.3,
            name: None,
            note: Some("Great quote".to_string()),
            created_at: 1700000200,
            updated_at: 1700000200,
            deleted_at: None,
        };
        insert_bookmark(&conn, &bookmark).unwrap();

        let bookmarks = list_bookmarks(&conn, "book-3").unwrap();
        assert_eq!(bookmarks.len(), 1);
        assert_eq!(bookmarks[0].note, Some("Great quote".to_string()));

        delete_bookmark(&conn, "bm-1").unwrap();
        let bookmarks2 = list_bookmarks(&conn, "book-3").unwrap();
        assert_eq!(bookmarks2.len(), 0);
    }

    #[test]
    fn test_update_bookmark_name() {
        let (_dir, conn) = setup();
        let book = sample_book("book-bm-name");
        insert_book(&conn, &book).unwrap();

        let bookmark = Bookmark {
            id: "bm-name-1".to_string(),
            book_id: "book-bm-name".to_string(),
            chapter_index: 1,
            scroll_position: 0.5,
            name: None,
            note: None,
            created_at: 1700000400,
            updated_at: 1700000400,
            deleted_at: None,
        };
        insert_bookmark(&conn, &bookmark).unwrap();

        let bookmarks = list_bookmarks(&conn, "book-bm-name").unwrap();
        assert_eq!(bookmarks[0].name, None);

        update_bookmark_name(&conn, "bm-name-1", Some("Important passage")).unwrap();
        let bookmarks = list_bookmarks(&conn, "book-bm-name").unwrap();
        assert_eq!(bookmarks[0].name, Some("Important passage".to_string()));

        update_bookmark_name(&conn, "bm-name-1", None).unwrap();
        let bookmarks = list_bookmarks(&conn, "book-bm-name").unwrap();
        assert_eq!(bookmarks[0].name, None);
    }

    #[test]
    fn test_delete_book_cascades_to_related_rows() {
        let (_dir, conn) = setup();
        let book = sample_book("book-cascade");
        insert_book(&conn, &book).unwrap();

        let bookmark = Bookmark {
            id: "bm-cascade".to_string(),
            book_id: "book-cascade".to_string(),
            chapter_index: 1,
            scroll_position: 0.1,
            name: None,
            note: None,
            created_at: 1700000300,
            updated_at: 1700000300,
            deleted_at: None,
        };
        insert_bookmark(&conn, &bookmark).unwrap();

        let progress = ReadingProgress {
            book_id: "book-cascade".to_string(),
            chapter_index: 1,
            scroll_position: 0.1,
            last_read_at: 1700000300,
        };
        upsert_reading_progress(&conn, &progress).unwrap();

        // Deleting the book must cascade to both child tables.
        delete_book(&conn, "book-cascade").unwrap();

        let bookmarks = list_bookmarks(&conn, "book-cascade").unwrap();
        assert!(
            bookmarks.is_empty(),
            "bookmarks should be deleted via cascade"
        );

        let rp = get_reading_progress(&conn, "book-cascade").unwrap();
        assert!(
            rp.is_none(),
            "reading_progress should be deleted via cascade"
        );
    }

    fn sample_collection(id: &str, coll_type: CollectionType) -> Collection {
        Collection {
            id: id.to_string(),
            name: format!("Collection {id}"),
            r#type: coll_type,
            icon: None,
            color: None,
            created_at: 1700000000,
            updated_at: 1700000000,
            rules: vec![],
        }
    }

    #[test]
    fn test_insert_and_list_collections() {
        let (_dir, conn) = setup();

        let manual = sample_collection("coll-manual", CollectionType::Manual);
        let automated = sample_collection("coll-auto", CollectionType::Automated);
        insert_collection(&conn, &manual).unwrap();
        insert_collection(&conn, &automated).unwrap();

        let collections = list_collections(&conn).unwrap();
        assert_eq!(collections.len(), 2);
        let names: Vec<&str> = collections.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"Collection coll-manual"));
        assert!(names.contains(&"Collection coll-auto"));

        let auto = collections.iter().find(|c| c.id == "coll-auto").unwrap();
        assert!(matches!(auto.r#type, CollectionType::Automated));
    }

    #[test]
    fn test_add_and_remove_book_from_collection() {
        let (_dir, conn) = setup();
        let book = sample_book("book-coll-1");
        insert_book(&conn, &book).unwrap();
        let coll = sample_collection("coll-c1", CollectionType::Manual);
        insert_collection(&conn, &coll).unwrap();

        add_book_to_collection(&conn, "book-coll-1", "coll-c1").unwrap();
        let books = get_books_in_collection(&conn, "coll-c1").unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].id, "book-coll-1");

        remove_book_from_collection(&conn, "book-coll-1", "coll-c1").unwrap();
        let books2 = get_books_in_collection(&conn, "coll-c1").unwrap();
        assert!(books2.is_empty());
    }

    #[test]
    fn test_add_book_to_collection_duplicate_is_noop() {
        let (_dir, conn) = setup();
        let book = sample_book("book-dup-coll");
        insert_book(&conn, &book).unwrap();
        let coll = sample_collection("coll-dup", CollectionType::Manual);
        insert_collection(&conn, &coll).unwrap();

        add_book_to_collection(&conn, "book-dup-coll", "coll-dup").unwrap();
        // Second insert must succeed silently (INSERT OR IGNORE), not error.
        add_book_to_collection(&conn, "book-dup-coll", "coll-dup").unwrap();
        let books = get_books_in_collection(&conn, "coll-dup").unwrap();
        assert_eq!(
            books.len(),
            1,
            "duplicate insert should be ignored, not doubled"
        );
    }

    #[test]
    fn test_delete_book_cascades_to_book_collections() {
        let (_dir, conn) = setup();
        let book = sample_book("book-cas-coll");
        insert_book(&conn, &book).unwrap();
        let coll = sample_collection("coll-cas", CollectionType::Manual);
        insert_collection(&conn, &coll).unwrap();

        add_book_to_collection(&conn, "book-cas-coll", "coll-cas").unwrap();
        let before = get_books_in_collection(&conn, "coll-cas").unwrap();
        assert_eq!(before.len(), 1);

        delete_book(&conn, "book-cas-coll").unwrap();
        let after = get_books_in_collection(&conn, "coll-cas").unwrap();
        assert!(
            after.is_empty(),
            "book_collections row should be deleted via cascade"
        );
    }

    #[test]
    fn test_books_have_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(dir.path().join("test.db").as_path()).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, updated_at) VALUES ('t1', 'T', 'A', '/t', 0, 100, 'epub', 100)",
            [],
        ).unwrap();
        let val: i64 = conn
            .query_row("SELECT updated_at FROM books WHERE id = 't1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(val, 100);
    }

    #[test]
    fn test_bookmarks_have_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(dir.path().join("test.db").as_path()).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, updated_at) VALUES ('b1', 'T', 'A', '/t', 0, 100, 'epub', 100)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO bookmarks (id, book_id, chapter_index, scroll_position, created_at, updated_at) VALUES ('bm1', 'b1', 0, 0.0, 100, 100)",
            [],
        ).unwrap();
        let val: i64 = conn
            .query_row(
                "SELECT updated_at FROM bookmarks WHERE id = 'bm1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(val, 100);
    }

    #[test]
    fn test_highlights_have_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(dir.path().join("test.db").as_path()).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, updated_at) VALUES ('b1', 'T', 'A', '/t', 0, 100, 'epub', 100)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO highlights (id, book_id, chapter_index, text, color, start_offset, end_offset, created_at, updated_at) VALUES ('h1', 'b1', 0, 'hi', '#fff', 0, 2, 100, 100)",
            [],
        ).unwrap();
        let val: i64 = conn
            .query_row(
                "SELECT updated_at FROM highlights WHERE id = 'h1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(val, 100);
    }

    #[test]
    fn test_books_have_enrichment_status() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(dir.path().join("test.db").as_path()).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, updated_at) VALUES ('t1', 'T', 'A', '/t', 0, 100, 'epub', 100)",
            [],
        ).unwrap();
        let val: Option<String> = conn
            .query_row(
                "SELECT enrichment_status FROM books WHERE id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(val.is_none());
    }

    #[test]
    fn bookmarks_book_id_index_exists() {
        let (_dir, conn) = setup();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_bookmarks_book_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "idx_bookmarks_book_id index should exist");
    }

    fn sample_activity(id: &str, action: &str, timestamp: i64) -> crate::models::ActivityEntry {
        crate::models::ActivityEntry {
            id: id.to_string(),
            timestamp,
            action: action.to_string(),
            entity_type: "book".to_string(),
            entity_id: Some("book-1".to_string()),
            entity_name: Some("Test Book".to_string()),
            detail: Some("some detail".to_string()),
        }
    }

    #[test]
    fn test_activity_log_crud() {
        let (_dir, conn) = setup();
        let entry = sample_activity("act-1", "import", 1700000000);
        insert_activity(&conn, &entry).unwrap();

        let results = get_activity_log(&conn, 100, 0, None).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "act-1");
        assert_eq!(results[0].action, "import");
        assert_eq!(results[0].entity_type, "book");
        assert_eq!(results[0].entity_id, Some("book-1".to_string()));
        assert_eq!(results[0].entity_name, Some("Test Book".to_string()));
        assert_eq!(results[0].detail, Some("some detail".to_string()));
        assert_eq!(results[0].timestamp, 1700000000);
    }

    #[test]
    fn test_activity_log_ordering() {
        let (_dir, conn) = setup();
        insert_activity(&conn, &sample_activity("act-a", "import", 1000)).unwrap();
        insert_activity(&conn, &sample_activity("act-b", "import", 3000)).unwrap();
        insert_activity(&conn, &sample_activity("act-c", "import", 2000)).unwrap();

        let results = get_activity_log(&conn, 100, 0, None).unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].id, "act-b"); // most recent first
        assert_eq!(results[1].id, "act-c");
        assert_eq!(results[2].id, "act-a");
    }

    #[test]
    fn test_activity_log_filter_by_action() {
        let (_dir, conn) = setup();
        insert_activity(&conn, &sample_activity("act-f1", "import", 1000)).unwrap();
        insert_activity(&conn, &sample_activity("act-f2", "delete", 2000)).unwrap();

        let imports = get_activity_log(&conn, 100, 0, Some("import")).unwrap();
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].id, "act-f1");

        let deletes = get_activity_log(&conn, 100, 0, Some("delete")).unwrap();
        assert_eq!(deletes.len(), 1);
        assert_eq!(deletes[0].id, "act-f2");
    }

    #[test]
    fn test_activity_log_pruning() {
        let (_dir, conn) = setup();
        let now = chrono::Utc::now().timestamp();
        // 2 old entries (>90 days) that will fall outside top 3
        insert_activity(
            &conn,
            &sample_activity("act-p0", "import", now - 100 * 86400),
        )
        .unwrap();
        insert_activity(
            &conn,
            &sample_activity("act-p1", "import", now - 95 * 86400),
        )
        .unwrap();
        // 3 recent entries that will be in the top 3
        for i in 2..5 {
            insert_activity(
                &conn,
                &sample_activity(&format!("act-p{i}"), "import", now - 60 + i as i64),
            )
            .unwrap();
        }

        prune_activity_log(&conn, 3).unwrap();

        let results = get_activity_log(&conn, 100, 0, None).unwrap();
        assert_eq!(results.len(), 3);
        // Should keep the 3 most recent
        assert_eq!(results[0].id, "act-p4");
        assert_eq!(results[1].id, "act-p3");
        assert_eq!(results[2].id, "act-p2");
    }

    #[test]
    fn test_activity_log_age_pruning() {
        let (_dir, conn) = setup();
        let now = chrono::Utc::now().timestamp();
        // Insert 2 old entries (>90 days) and 2 recent entries
        insert_activity(
            &conn,
            &sample_activity("act-old1", "import", now - 100 * 86400),
        )
        .unwrap();
        insert_activity(
            &conn,
            &sample_activity("act-old2", "import", now - 91 * 86400),
        )
        .unwrap();
        insert_activity(
            &conn,
            &sample_activity("act-new1", "import", now - 10 * 86400),
        )
        .unwrap();
        insert_activity(
            &conn,
            &sample_activity("act-new2", "import", now - 1 * 86400),
        )
        .unwrap();

        // keep=2 means old entries outside top 2 AND older than 90 days are pruned
        prune_activity_log(&conn, 2).unwrap();

        let results = get_activity_log(&conn, 100, 0, None).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "act-new2");
        assert_eq!(results[1].id, "act-new1");
    }

    #[test]
    fn test_custom_font_crud() {
        let (_dir, conn) = setup();

        let font = CustomFont {
            id: "font-1".to_string(),
            name: "Merriweather".to_string(),
            file_name: "Merriweather-Regular.ttf".to_string(),
            file_path: "/tmp/fonts/font-1.ttf".to_string(),
            created_at: 1700000500,
        };
        insert_custom_font(&conn, &font).unwrap();

        let fonts = list_custom_fonts(&conn).unwrap();
        assert_eq!(fonts.len(), 1);
        assert_eq!(fonts[0].name, "Merriweather");
        assert_eq!(fonts[0].file_path, "/tmp/fonts/font-1.ttf");

        let fetched = get_custom_font(&conn, "font-1").unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().file_name, "Merriweather-Regular.ttf");

        let missing = get_custom_font(&conn, "no-such-font").unwrap();
        assert!(missing.is_none());

        delete_custom_font(&conn, "font-1").unwrap();
        let fonts = list_custom_fonts(&conn).unwrap();
        assert_eq!(fonts.len(), 0);
    }

    #[test]
    fn test_list_series() {
        let (_dir, conn) = setup();

        let mut book1 = sample_book("s1");
        book1.file_path = "/tmp/s1.epub".to_string();
        book1.series = Some("Dune".to_string());
        book1.volume = Some(1);
        insert_book(&conn, &book1).unwrap();

        let mut book2 = sample_book("s2");
        book2.file_path = "/tmp/s2.epub".to_string();
        book2.series = Some("Dune".to_string());
        book2.volume = Some(2);
        insert_book(&conn, &book2).unwrap();

        let mut book3 = sample_book("s3");
        book3.file_path = "/tmp/s3.epub".to_string();
        book3.series = Some("Foundation".to_string());
        book3.volume = Some(1);
        insert_book(&conn, &book3).unwrap();

        // Single book in series — should NOT appear (threshold is 2+)
        let mut book4 = sample_book("s4");
        book4.file_path = "/tmp/s4.epub".to_string();
        book4.series = Some("Neuromancer".to_string());
        book4.volume = Some(1);
        insert_book(&conn, &book4).unwrap();

        // Book without series
        let mut book5 = sample_book("s5");
        book5.file_path = "/tmp/s5.epub".to_string();
        insert_book(&conn, &book5).unwrap();

        let series = list_series(&conn).unwrap();
        assert_eq!(series.len(), 1); // Only "Dune" has 2+ books
        assert_eq!(series[0].name, "Dune");
        assert_eq!(series[0].count, 2);
    }

    #[test]
    fn test_books_have_is_imported() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = Connection::open(&db_path).unwrap();
        run_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, is_imported) VALUES ('b1', 'Test', 'Author', '/tmp/test.epub', 1, 0, 'epub', 1)",
            [],
        ).unwrap();

        let is_imported: i32 = conn
            .query_row("SELECT is_imported FROM books WHERE id = 'b1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(is_imported, 1);

        conn.execute(
            "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, is_imported) VALUES ('b2', 'Linked', 'Author', '/mnt/nas/book.epub', 1, 0, 'epub', 0)",
            [],
        ).unwrap();

        let is_imported: i32 = conn
            .query_row("SELECT is_imported FROM books WHERE id = 'b2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(is_imported, 0);
    }

    #[test]
    fn test_update_book_path() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = init_db(&db_path).unwrap();

        conn.execute(
            "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, is_imported) VALUES ('b1', 'Test', 'Author', '/mnt/nas/book.epub', 1, 0, 'epub', 0)",
            [],
        ).unwrap();

        update_book_path(&conn, "b1", "/library/b1.epub", true).unwrap();

        let (path, imported): (String, i32) = conn
            .query_row(
                "SELECT file_path, is_imported FROM books WHERE id = 'b1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(path, "/library/b1.epub");
        assert_eq!(imported, 1);
    }

    #[test]
    fn test_soft_deleted_bookmark_excluded_from_list() {
        let (_dir, conn) = setup();
        let book = sample_book("book-sd");
        insert_book(&conn, &book).unwrap();

        let bm = Bookmark {
            id: "bm-sd-1".to_string(),
            book_id: "book-sd".to_string(),
            chapter_index: 0,
            scroll_position: 0.0,
            name: None,
            note: None,
            created_at: 1700000000,
            updated_at: 1700000000,
            deleted_at: None,
        };
        insert_bookmark(&conn, &bm).unwrap();

        // Verify it appears before soft-delete
        let before = list_bookmarks(&conn, "book-sd").unwrap();
        assert_eq!(before.len(), 1);

        // Soft-delete via raw SQL
        conn.execute(
            "UPDATE bookmarks SET deleted_at = 1700001000 WHERE id = 'bm-sd-1'",
            [],
        )
        .unwrap();

        // Should be excluded from list
        let after = list_bookmarks(&conn, "book-sd").unwrap();
        assert!(after.is_empty(), "soft-deleted bookmark should be excluded");
    }

    #[test]
    fn test_soft_deleted_highlight_excluded_from_list() {
        let (_dir, conn) = setup();
        let book = sample_book("book-sdh");
        insert_book(&conn, &book).unwrap();

        let hl = crate::models::Highlight {
            id: "hl-sd-1".to_string(),
            book_id: "book-sdh".to_string(),
            chapter_index: 1,
            text: "some text".to_string(),
            color: "#ff0".to_string(),
            note: None,
            start_offset: 0,
            end_offset: 9,
            created_at: 1700000000,
            updated_at: 1700000000,
            deleted_at: None,
        };
        insert_highlight(&conn, &hl).unwrap();

        // Verify it appears before soft-delete
        let before = list_highlights(&conn, "book-sdh").unwrap();
        assert_eq!(before.len(), 1);

        // Also check get_chapter_highlights
        let ch_before = get_chapter_highlights(&conn, "book-sdh", 1).unwrap();
        assert_eq!(ch_before.len(), 1);

        // Soft-delete via raw SQL
        conn.execute(
            "UPDATE highlights SET deleted_at = 1700001000 WHERE id = 'hl-sd-1'",
            [],
        )
        .unwrap();

        // Should be excluded from both queries
        let after = list_highlights(&conn, "book-sdh").unwrap();
        assert!(
            after.is_empty(),
            "soft-deleted highlight should be excluded from list_highlights"
        );

        let ch_after = get_chapter_highlights(&conn, "book-sdh", 1).unwrap();
        assert!(
            ch_after.is_empty(),
            "soft-deleted highlight should be excluded from get_chapter_highlights"
        );
    }

    #[test]
    fn test_deleted_at_column_exists_after_migration() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_db(dir.path().join("test.db").as_path()).unwrap();

        // Verify deleted_at column exists on bookmarks by inserting a value
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format) VALUES ('b1', 'T', 'A', '/t', 0, 100, 'epub')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO bookmarks (id, book_id, chapter_index, scroll_position, created_at, updated_at, deleted_at) VALUES ('bm1', 'b1', 0, 0.0, 100, 100, 999)",
            [],
        ).unwrap();
        let val: Option<i64> = conn
            .query_row(
                "SELECT deleted_at FROM bookmarks WHERE id = 'bm1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(val, Some(999));

        // Verify deleted_at column exists on highlights
        conn.execute(
            "INSERT INTO highlights (id, book_id, chapter_index, text, color, start_offset, end_offset, created_at, updated_at, deleted_at) VALUES ('h1', 'b1', 0, 'hi', '#fff', 0, 2, 100, 100, 888)",
            [],
        ).unwrap();
        let val: Option<i64> = conn
            .query_row(
                "SELECT deleted_at FROM highlights WHERE id = 'h1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(val, Some(888));

        // NULL by default when not set
        conn.execute(
            "INSERT INTO bookmarks (id, book_id, chapter_index, scroll_position, created_at, updated_at) VALUES ('bm2', 'b1', 0, 0.0, 100, 100)",
            [],
        ).unwrap();
        let null_val: Option<i64> = conn
            .query_row(
                "SELECT deleted_at FROM bookmarks WHERE id = 'bm2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(null_val.is_none(), "deleted_at should default to NULL");
    }

    #[test]
    fn test_updated_at_backfill() {
        // Simulate a pre-migration database: create schema, insert rows with updated_at=0,
        // then run schema again to trigger backfill.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        run_schema(&conn).unwrap();

        // Insert book with updated_at = 0 (simulating pre-migration row)
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, total_chapters, added_at, format, updated_at) VALUES ('b1', 'T', 'A', '/t', 0, 500, 'epub', 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO bookmarks (id, book_id, chapter_index, scroll_position, created_at, updated_at) VALUES ('bm1', 'b1', 0, 0.0, 300, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO highlights (id, book_id, chapter_index, text, color, start_offset, end_offset, created_at, updated_at) VALUES ('h1', 'b1', 0, 'x', '#000', 0, 1, 400, 0)",
            [],
        ).unwrap();

        // Re-run schema to trigger backfill
        run_schema(&conn).unwrap();

        let book_updated: i64 = conn
            .query_row("SELECT updated_at FROM books WHERE id = 'b1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            book_updated, 500,
            "book updated_at should be backfilled to added_at"
        );

        let bm_updated: i64 = conn
            .query_row(
                "SELECT updated_at FROM bookmarks WHERE id = 'bm1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            bm_updated, 300,
            "bookmark updated_at should be backfilled to created_at"
        );

        let hl_updated: i64 = conn
            .query_row(
                "SELECT updated_at FROM highlights WHERE id = 'h1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            hl_updated, 400,
            "highlight updated_at should be backfilled to created_at"
        );
    }

    #[test]
    fn test_soft_delete_bookmark() {
        let (_dir, conn) = setup();
        let book = sample_book("book-sdb");
        insert_book(&conn, &book).unwrap();

        let bm = Bookmark {
            id: "bm-soft-1".to_string(),
            book_id: "book-sdb".to_string(),
            chapter_index: 1,
            scroll_position: 0.5,
            name: None,
            note: Some("test note".to_string()),
            created_at: 1700000000,
            updated_at: 1700000000,
            deleted_at: None,
        };
        insert_bookmark(&conn, &bm).unwrap();

        // Bookmark visible before soft delete
        let before = list_bookmarks(&conn, "book-sdb").unwrap();
        assert_eq!(before.len(), 1);

        // Soft delete
        soft_delete_bookmark(&conn, "bm-soft-1").unwrap();

        // Not returned by list_bookmarks
        let after = list_bookmarks(&conn, "book-sdb").unwrap();
        assert!(
            after.is_empty(),
            "soft-deleted bookmark should not appear in list"
        );

        // Row still exists in DB with deleted_at set
        let (deleted_at, updated_at): (Option<i64>, i64) = conn
            .query_row(
                "SELECT deleted_at, updated_at FROM bookmarks WHERE id = 'bm-soft-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(deleted_at.is_some(), "deleted_at should be set");
        assert_eq!(
            deleted_at,
            Some(updated_at),
            "deleted_at and updated_at should match"
        );
        assert!(updated_at > 1700000000, "updated_at should be bumped");
    }

    #[test]
    fn test_soft_delete_bookmark_idempotent() {
        let (_dir, conn) = setup();
        let book = sample_book("book-sdb-idem");
        insert_book(&conn, &book).unwrap();

        let bm = Bookmark {
            id: "bm-idem-1".to_string(),
            book_id: "book-sdb-idem".to_string(),
            chapter_index: 0,
            scroll_position: 0.0,
            name: None,
            note: None,
            created_at: 1700000000,
            updated_at: 1700000000,
            deleted_at: None,
        };
        insert_bookmark(&conn, &bm).unwrap();

        // First soft delete
        soft_delete_bookmark(&conn, "bm-idem-1").unwrap();
        let first_deleted_at: i64 = conn
            .query_row(
                "SELECT deleted_at FROM bookmarks WHERE id = 'bm-idem-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        // Second soft delete should not change deleted_at
        soft_delete_bookmark(&conn, "bm-idem-1").unwrap();
        let second_deleted_at: i64 = conn
            .query_row(
                "SELECT deleted_at FROM bookmarks WHERE id = 'bm-idem-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(
            first_deleted_at, second_deleted_at,
            "deleted_at should not change on second soft delete"
        );
    }

    #[test]
    fn test_soft_delete_highlight() {
        let (_dir, conn) = setup();
        let book = sample_book("book-sdh2");
        insert_book(&conn, &book).unwrap();

        let hl = crate::models::Highlight {
            id: "hl-soft-1".to_string(),
            book_id: "book-sdh2".to_string(),
            chapter_index: 2,
            text: "highlighted text".to_string(),
            color: "#ff0".to_string(),
            note: None,
            start_offset: 10,
            end_offset: 26,
            created_at: 1700000000,
            updated_at: 1700000000,
            deleted_at: None,
        };
        insert_highlight(&conn, &hl).unwrap();

        // Highlight visible before soft delete
        let before = list_highlights(&conn, "book-sdh2").unwrap();
        assert_eq!(before.len(), 1);

        // Soft delete
        soft_delete_highlight(&conn, "hl-soft-1").unwrap();

        // Not returned by list_highlights
        let after = list_highlights(&conn, "book-sdh2").unwrap();
        assert!(
            after.is_empty(),
            "soft-deleted highlight should not appear in list"
        );

        // Not returned by get_chapter_highlights either
        let ch_after = get_chapter_highlights(&conn, "book-sdh2", 2).unwrap();
        assert!(
            ch_after.is_empty(),
            "soft-deleted highlight should not appear in chapter list"
        );

        // Row still exists in DB with deleted_at set
        let (deleted_at, updated_at): (Option<i64>, i64) = conn
            .query_row(
                "SELECT deleted_at, updated_at FROM highlights WHERE id = 'hl-soft-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(deleted_at.is_some(), "deleted_at should be set");
        assert_eq!(
            deleted_at,
            Some(updated_at),
            "deleted_at and updated_at should match"
        );
        assert!(updated_at > 1700000000, "updated_at should be bumped");
    }

    #[test]
    fn test_get_or_create_device_id() {
        let (_dir, conn) = setup();

        // First call creates a UUID
        let id1 = get_or_create_device_id(&conn).unwrap();
        assert_eq!(id1.len(), 36, "UUID v4 string should be 36 chars");

        // Second call returns the same ID
        let id2 = get_or_create_device_id(&conn).unwrap();
        assert_eq!(id1, id2, "device_id should be stable across calls");
    }

    #[test]
    fn test_is_sync_enabled() {
        let (_dir, conn) = setup();

        // Missing key → false
        assert!(!is_sync_enabled(&conn));

        // "true" → true
        set_setting(&conn, "sync_enabled", "true").unwrap();
        assert!(is_sync_enabled(&conn));

        // "false" → false
        set_setting(&conn, "sync_enabled", "false").unwrap();
        assert!(!is_sync_enabled(&conn));

        // "yes" → false (only exact "true" is truthy)
        set_setting(&conn, "sync_enabled", "yes").unwrap();
        assert!(!is_sync_enabled(&conn));
    }
}
