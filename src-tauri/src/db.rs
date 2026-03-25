use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, Result, params};
use std::path::Path;

use crate::models::{Book, Bookmark, Collection, CollectionRule, CollectionType, ReadingProgress};

pub type DbPool = Pool<SqliteConnectionManager>;

fn run_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("
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
            field TEXT NOT NULL CHECK(field IN ('author','format','date_added','reading_progress')),
            operator TEXT NOT NULL,
            value TEXT NOT NULL
        );

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
    ")?;

    // Additive migrations: ALTER TABLE ADD COLUMN fails silently if already exists.
    let _ = conn.execute_batch(
        "ALTER TABLE books ADD COLUMN format TEXT NOT NULL DEFAULT 'epub';",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE books ADD COLUMN file_hash TEXT;",
    );
    let _ = conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_books_file_hash ON books(file_hash);",
    );

    Ok(())
}

pub fn create_pool(db_path: &Path) -> Result<DbPool, Box<dyn std::error::Error>> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let manager = SqliteConnectionManager::file(db_path)
        .with_init(|conn| conn.execute_batch("PRAGMA foreign_keys = ON;"));

    let pool = Pool::new(manager)?;

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
        "INSERT INTO books (id, title, author, file_path, cover_path, total_chapters, added_at, format, file_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
        ],
    )?;
    Ok(())
}

pub fn get_book(conn: &Connection, id: &str) -> Result<Option<Book>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, file_path, cover_path, total_chapters, added_at, format, file_hash
         FROM books WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        let format_str: String = row.get(7)?;
        Ok(Some(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            file_path: row.get(3)?,
            cover_path: row.get(4)?,
            total_chapters: row.get(5)?,
            added_at: row.get(6)?,
            format: format_str.parse().map_err(|e: String| rusqlite::Error::InvalidParameterName(e))?,
            file_hash: row.get(8)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_book_by_file_path(conn: &Connection, file_path: &str) -> Result<Option<Book>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, file_path, cover_path, total_chapters, added_at, format, file_hash
         FROM books WHERE file_path = ?1",
    )?;
    let mut rows = stmt.query(params![file_path])?;
    if let Some(row) = rows.next()? {
        let format_str: String = row.get(7)?;
        Ok(Some(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            file_path: row.get(3)?,
            cover_path: row.get(4)?,
            total_chapters: row.get(5)?,
            added_at: row.get(6)?,
            format: format_str.parse().map_err(|e: String| rusqlite::Error::InvalidParameterName(e))?,
            file_hash: row.get(8)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_book_by_file_hash(conn: &Connection, hash: &str) -> Result<Option<Book>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, file_path, cover_path, total_chapters, added_at, format, file_hash
         FROM books WHERE file_hash = ?1",
    )?;
    let mut rows = stmt.query(params![hash])?;
    if let Some(row) = rows.next()? {
        let format_str: String = row.get(7)?;
        Ok(Some(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            file_path: row.get(3)?,
            cover_path: row.get(4)?,
            total_chapters: row.get(5)?,
            added_at: row.get(6)?,
            format: format_str.parse().map_err(|e: String| rusqlite::Error::InvalidParameterName(e))?,
            file_hash: row.get(8)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn list_books(conn: &Connection) -> Result<Vec<Book>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, file_path, cover_path, total_chapters, added_at, format, file_hash
         FROM books ORDER BY added_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let format_str: String = row.get(7)?;
        Ok(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            file_path: row.get(3)?,
            cover_path: row.get(4)?,
            total_chapters: row.get(5)?,
            added_at: row.get(6)?,
            format: format_str.parse().map_err(|e: String| rusqlite::Error::InvalidParameterName(e))?,
            file_hash: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn update_book(conn: &Connection, book: &Book) -> Result<()> {
    // file_hash is immutable after import — not included in update
    conn.execute(
        "UPDATE books SET title=?2, author=?3, file_path=?4, cover_path=?5,
         total_chapters=?6, added_at=?7, format=?8 WHERE id=?1",
        params![
            book.id,
            book.title,
            book.author,
            book.file_path,
            book.cover_path,
            book.total_chapters,
            book.added_at,
            book.format.to_string(),
        ],
    )?;
    Ok(())
}

pub fn delete_book(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn update_book_file_path(conn: &Connection, book_id: &str, new_path: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET file_path = ?2 WHERE id = ?1",
        params![book_id, new_path],
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

// --- Bookmark CRUD ---

pub fn insert_bookmark(conn: &Connection, bookmark: &Bookmark) -> Result<()> {
    conn.execute(
        "INSERT INTO bookmarks (id, book_id, chapter_index, scroll_position, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            bookmark.id,
            bookmark.book_id,
            bookmark.chapter_index,
            bookmark.scroll_position,
            bookmark.note,
            bookmark.created_at,
        ],
    )?;
    Ok(())
}

pub fn list_bookmarks(conn: &Connection, book_id: &str) -> Result<Vec<Bookmark>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, chapter_index, scroll_position, note, created_at
         FROM bookmarks WHERE book_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |row| {
        Ok(Bookmark {
            id: row.get(0)?,
            book_id: row.get(1)?,
            chapter_index: row.get(2)?,
            scroll_position: row.get(3)?,
            note: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn delete_bookmark(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    Ok(())
}

// --- Collections CRUD ---

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
    })
}

pub fn insert_collection(conn: &Connection, collection: &Collection) -> Result<()> {
    let type_str = match collection.r#type {
        CollectionType::Manual => "manual",
        CollectionType::Automated => "automated",
    };
    conn.execute(
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
        conn.execute(
            "INSERT INTO collection_rules (id, collection_id, field, operator, value)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![rule.id, rule.collection_id, rule.field, rule.operator, rule.value],
        )?;
    }
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

    let mut result = Vec::with_capacity(collections.len());
    for mut coll in collections {
        coll.rules = get_collection_rules(conn, &coll.id)?;
        result.push(coll);
    }
    Ok(result)
}

pub fn delete_collection(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn add_book_to_collection(
    conn: &Connection,
    book_id: &str,
    collection_id: &str,
) -> Result<()> {
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

pub fn get_books_in_collection(conn: &Connection, collection_id: &str) -> Result<Vec<Book>> {
    let mut type_stmt =
        conn.prepare("SELECT type FROM collections WHERE id = ?1")?;
    let coll_type: String =
        type_stmt.query_row(params![collection_id], |row| row.get(0))?;

    if coll_type == "manual" {
        let mut stmt = conn.prepare(
            "SELECT b.id, b.title, b.author, b.file_path, b.cover_path, b.total_chapters, b.added_at, b.format, b.file_hash
             FROM books b
             JOIN book_collections bc ON bc.book_id = b.id
             WHERE bc.collection_id = ?1
             ORDER BY bc.added_at DESC",
        )?;
        let rows = stmt.query_map(params![collection_id], row_to_book)?;
        return rows.collect();
    }

    // Automated: build a dynamic parameterized query from collection rules.
    let rules = get_collection_rules(conn, collection_id)?;

    let mut join_clauses: Vec<String> = Vec::new();
    let mut where_clauses: Vec<String> = Vec::new();
    let mut param_values: Vec<String> = Vec::new();
    let mut rp_idx: u32 = 0;

    for rule in &rules {
        match (rule.field.as_str(), rule.operator.as_str()) {
            ("author", "contains") => {
                where_clauses.push("b.author LIKE ?".to_string());
                param_values.push(format!("%{}%", rule.value));
            }
            ("format", "equals") => {
                where_clauses.push("b.format = ?".to_string());
                param_values.push(rule.value.clone());
            }
            ("date_added", "last_n_days") => {
                where_clauses.push(
                    "b.added_at > (strftime('%s', 'now') - CAST(? AS INTEGER) * 86400)"
                        .to_string(),
                );
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
                        where_clauses.push(format!(
                            "{alias}.chapter_index < b.total_chapters - 1"
                        ));
                    }
                    "finished" => {
                        join_clauses.push(format!(
                            "JOIN reading_progress {alias} ON {alias}.book_id = b.id"
                        ));
                        where_clauses.push(format!(
                            "{alias}.chapter_index >= b.total_chapters - 1"
                        ));
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

    let sql = format!(
        "SELECT b.id, b.title, b.author, b.file_path, b.cover_path, b.total_chapters, b.added_at, b.format, b.file_hash
         FROM books b
         {joins}
         {where_str}
         ORDER BY b.added_at DESC"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(param_values.iter()), row_to_book)?;
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

        let updated = Book { title: "Updated Title".to_string(), ..book };
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

        let updated = ReadingProgress { chapter_index: 5, scroll_position: 0.8, ..progress };
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
        let duplicate = Book { id: "book-dup-2".to_string(), ..book };
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
            note: Some("Great quote".to_string()),
            created_at: 1700000200,
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
    fn test_delete_book_cascades_to_related_rows() {
        let (_dir, conn) = setup();
        let book = sample_book("book-cascade");
        insert_book(&conn, &book).unwrap();

        let bookmark = Bookmark {
            id: "bm-cascade".to_string(),
            book_id: "book-cascade".to_string(),
            chapter_index: 1,
            scroll_position: 0.1,
            note: None,
            created_at: 1700000300,
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
        assert!(bookmarks.is_empty(), "bookmarks should be deleted via cascade");

        let rp = get_reading_progress(&conn, "book-cascade").unwrap();
        assert!(rp.is_none(), "reading_progress should be deleted via cascade");
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
        assert_eq!(books.len(), 1, "duplicate insert should be ignored, not doubled");
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
        assert!(after.is_empty(), "book_collections row should be deleted via cascade");
    }
}
