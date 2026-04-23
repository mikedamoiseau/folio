export interface Book {
  id: string;
  title: string;
  author: string;
  file_path: string;
  cover_path: string | null;
  total_chapters: number;
  added_at: number;
  format: "epub" | "cbz" | "cbr" | "pdf" | "mobi";
  description: string | null;
  genres: string | null;
  rating: number | null;
  isbn: string | null;
  openlibrary_key: string | null;
  series: string | null;
  volume: number | null;
  language: string | null;
  publisher: string | null;
  publish_year: number | null;
  is_imported: boolean;
}

/** Lightweight book data for grid/list display — no description, genres, isbn, etc. */
export interface BookGridItem {
  id: string;
  title: string;
  author: string;
  cover_path: string | null;
  total_chapters: number;
  added_at: number;
  format: "epub" | "cbz" | "cbr" | "pdf" | "mobi";
  series: string | null;
  volume: number | null;
  rating: number | null;
  language: string | null;
  publish_year: number | null;
  is_imported: boolean;
}
