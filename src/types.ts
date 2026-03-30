export interface Book {
  id: string;
  title: string;
  author: string;
  file_path: string;
  cover_path: string | null;
  total_chapters: number;
  added_at: number;
  format: "epub" | "cbz" | "cbr" | "pdf";
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
  is_imported?: boolean;
}
