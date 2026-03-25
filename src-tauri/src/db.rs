use rusqlite::{Connection, Result, params};
use std::path::Path;

use crate::models::{Book, Bookmark, ReadingProgress};

pub fn init_db(db_path: &Path) -> Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(db_path)?;

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            file_path TEXT NOT NULL UNIQUE,
            cover_path TEXT,
            total_chapters INTEGER NOT NULL DEFAULT 0,
            added_at INTEGER NOT NULL
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
    ")?;

    Ok(conn)
}

// --- Book CRUD ---

pub fn insert_book(conn: &Connection, book: &Book) -> Result<()> {
    conn.execute(
        "INSERT INTO books (id, title, author, file_path, cover_path, total_chapters, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            book.id,
            book.title,
            book.author,
            book.file_path,
            book.cover_path,
            book.total_chapters,
            book.added_at,
        ],
    )?;
    Ok(())
}

pub fn get_book(conn: &Connection, id: &str) -> Result<Option<Book>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, file_path, cover_path, total_chapters, added_at
         FROM books WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            file_path: row.get(3)?,
            cover_path: row.get(4)?,
            total_chapters: row.get(5)?,
            added_at: row.get(6)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_book_by_file_path(conn: &Connection, file_path: &str) -> Result<Option<Book>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, file_path, cover_path, total_chapters, added_at
         FROM books WHERE file_path = ?1",
    )?;
    let mut rows = stmt.query(params![file_path])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            file_path: row.get(3)?,
            cover_path: row.get(4)?,
            total_chapters: row.get(5)?,
            added_at: row.get(6)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn list_books(conn: &Connection) -> Result<Vec<Book>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, file_path, cover_path, total_chapters, added_at
         FROM books ORDER BY added_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            file_path: row.get(3)?,
            cover_path: row.get(4)?,
            total_chapters: row.get(5)?,
            added_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn update_book(conn: &Connection, book: &Book) -> Result<()> {
    conn.execute(
        "UPDATE books SET title=?2, author=?3, file_path=?4, cover_path=?5,
         total_chapters=?6, added_at=?7 WHERE id=?1",
        params![
            book.id,
            book.title,
            book.author,
            book.file_path,
            book.cover_path,
            book.total_chapters,
            book.added_at,
        ],
    )?;
    Ok(())
}

pub fn delete_book(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
