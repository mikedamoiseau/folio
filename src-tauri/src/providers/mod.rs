pub mod google_books;
pub mod openlibrary;

use serde::{Deserialize, Serialize};

/// Common metadata returned by any enrichment provider.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentData {
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub genres: Vec<String>,
    pub rating: Option<f64>,
    pub isbn: Option<String>,
    pub cover_url: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub publish_year: Option<u16>,
    /// Identifier for the source (e.g., "openlibrary", "google_books")
    pub source: String,
    /// Provider-specific key for this result
    pub source_key: Option<String>,
}

/// Per-provider configuration stored in the settings table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub enabled: bool,
    pub api_key: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            api_key: None,
        }
    }
}

/// Metadata about a provider (for UI display and registration).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub requires_api_key: bool,
    pub api_key_help: String,
    pub config: ProviderConfig,
}

/// Trait that all enrichment providers implement.
pub trait EnrichmentProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn requires_api_key(&self) -> bool;
    fn api_key_help(&self) -> &str;
    fn search_by_isbn(&self, isbn: &str) -> Result<Vec<EnrichmentData>, String>;
    fn search_by_title(
        &self,
        title: &str,
        author: Option<&str>,
    ) -> Result<Vec<EnrichmentData>, String>;
    fn configure(&mut self, config: ProviderConfig);
    fn config(&self) -> &ProviderConfig;
}

pub struct ProviderRegistry {
    providers: Vec<Box<dyn EnrichmentProvider>>,
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: vec![
                Box::new(google_books::GoogleBooksProvider::new()),
                Box::new(openlibrary::OpenLibraryProvider::new()),
            ],
        }
    }

    pub fn list_providers(&self) -> Vec<ProviderInfo> {
        self.providers
            .iter()
            .map(|p| ProviderInfo {
                id: p.id().to_string(),
                name: p.name().to_string(),
                requires_api_key: p.requires_api_key(),
                api_key_help: p.api_key_help().to_string(),
                config: p.config().clone(),
            })
            .collect()
    }

    pub fn enabled_providers(&self) -> Vec<String> {
        self.providers
            .iter()
            .filter(|p| p.config().enabled)
            .map(|p| p.id().to_string())
            .collect()
    }

    pub fn configure_provider(&mut self, id: &str, config: ProviderConfig) {
        if let Some(p) = self.providers.iter_mut().find(|p| p.id() == id) {
            p.configure(config);
        }
    }

    /// Search by ISBN across enabled providers. Returns first non-empty result
    /// along with the list of providers that were tried.
    pub fn search_by_isbn(&self, isbn: &str) -> SearchOutcome {
        let mut tried = Vec::new();
        for provider in &self.providers {
            if !provider.config().enabled {
                continue;
            }
            tried.push(provider.name().to_string());
            match provider.search_by_isbn(isbn) {
                Ok(results) if !results.is_empty() => {
                    return SearchOutcome {
                        results,
                        providers_tried: tried,
                    };
                }
                _ => continue,
            }
        }
        SearchOutcome {
            results: Vec::new(),
            providers_tried: tried,
        }
    }

    /// Search by title across enabled providers. Returns first non-empty result
    /// along with the list of providers that were tried.
    pub fn search_by_title(&self, title: &str, author: Option<&str>) -> SearchOutcome {
        let mut tried = Vec::new();
        for provider in &self.providers {
            if !provider.config().enabled {
                continue;
            }
            tried.push(provider.name().to_string());
            match provider.search_by_title(title, author) {
                Ok(results) if !results.is_empty() => {
                    return SearchOutcome {
                        results,
                        providers_tried: tried,
                    };
                }
                _ => continue,
            }
        }
        SearchOutcome {
            results: Vec::new(),
            providers_tried: tried,
        }
    }
}

/// Result of a multi-provider search, including which providers were queried.
#[derive(Debug, Clone)]
pub struct SearchOutcome {
    pub results: Vec<EnrichmentData>,
    /// Names of providers that were tried, in order (e.g. ["Google Books", "OpenLibrary"]).
    pub providers_tried: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrichment_data_default() {
        let data = EnrichmentData::default();
        assert_eq!(data.title, "");
        assert_eq!(data.author, "");
        assert!(data.description.is_none());
        assert!(data.genres.is_empty());
        assert!(data.rating.is_none());
        assert!(data.isbn.is_none());
        assert!(data.cover_url.is_none());
        assert!(data.language.is_none());
        assert!(data.publisher.is_none());
        assert!(data.publish_year.is_none());
        assert_eq!(data.source, "");
        assert!(data.source_key.is_none());
    }

    #[test]
    fn provider_config_default() {
        let config = ProviderConfig::default();
        assert!(config.enabled);
        assert!(config.api_key.is_none());
    }

    #[test]
    fn registry_lists_providers_in_order() {
        let reg = ProviderRegistry::new();
        let providers = reg.list_providers();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].id, "google_books");
        assert_eq!(providers[0].name, "Google Books");
        assert_eq!(providers[1].id, "openlibrary");
        assert_eq!(providers[1].name, "OpenLibrary");
    }

    #[test]
    fn registry_get_enabled_providers() {
        let mut reg = ProviderRegistry::new();
        assert_eq!(reg.enabled_providers().len(), 2);
        reg.configure_provider(
            "google_books",
            ProviderConfig {
                enabled: false,
                api_key: None,
            },
        );
        let enabled = reg.enabled_providers();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0], "openlibrary");
    }
}
