//! Generic full-text search utilities for HTML content.
//!
//! Extracted from `epub::search_book` so MOBI books can reuse the same search
//! logic.

use ammonia::clean;

use crate::epub::{count_words, extract_snippet, strip_html_tags};
use crate::models::SearchResult;

const MAX_SEARCH_RESULTS: usize = 200;

/// Search HTML content for a query string (case-insensitive).
///
/// Strips HTML tags and sanitizes the input before searching.
/// Returns a list of `SearchResult`s, capped at `MAX_SEARCH_RESULTS`.
pub fn find_matches_in_html(
    html: &str,
    query: &str,
    chapter_index: u32,
    _book_id: &str, // For consistency with other adapters, currently unused
) -> Vec<SearchResult> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    let body_only = clean(html);
    let text = strip_html_tags(&body_only);
    let text_lower = text.to_lowercase();

    let mut search_from = 0;
    while let Some(pos) = text_lower[search_from..].find(&query_lower) {
        let match_start = search_from + pos;
        results.push(SearchResult {
            chapter_index,
            snippet: extract_snippet(&text, match_start, query_lower.len(), 40),
            match_offset: match_start,
        });
        if results.len() >= MAX_SEARCH_RESULTS {
            return results;
        }
        search_from = match_start + query_lower.len();
    }

    results
}

/// Strip HTML tags and count words in HTML content.
pub fn get_html_word_count(html: &str) -> usize {
    let body_only = clean(html);
    let text = strip_html_tags(&body_only);
    count_words(&text)
}