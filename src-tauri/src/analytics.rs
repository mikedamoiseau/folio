//! Opt-in, anonymous usage analytics. Single choke point for all telemetry.
//!
//! Consent is app-global (stored at `{data_dir}/analytics.json`), NOT in the
//! per-profile settings table — an opt-out must bind every profile. Default is
//! `unset` (nothing sent); any read error is treated as `unset` (fail-closed).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::FolioResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consent {
    Unset,
    Enabled,
    Disabled,
}

#[derive(Serialize, Deserialize)]
struct ConsentFile {
    consent: String,
}

impl Consent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Consent::Unset => "unset",
            Consent::Enabled => "enabled",
            Consent::Disabled => "disabled",
        }
    }

    pub fn parse(s: &str) -> Option<Consent> {
        match s {
            "unset" => Some(Consent::Unset),
            "enabled" => Some(Consent::Enabled),
            "disabled" => Some(Consent::Disabled),
            _ => None,
        }
    }
}

pub fn should_send(c: Consent) -> bool {
    matches!(c, Consent::Enabled)
}

pub fn consent_path(data_dir: &Path) -> PathBuf {
    data_dir.join("analytics.json")
}

pub fn read_consent(data_dir: &Path) -> Consent {
    let raw = match std::fs::read_to_string(consent_path(data_dir)) {
        Ok(s) => s,
        Err(_) => return Consent::Unset, // absent ⇒ fail-closed
    };
    match serde_json::from_str::<ConsentFile>(&raw) {
        Ok(f) => Consent::parse(&f.consent).unwrap_or(Consent::Unset),
        Err(_) => Consent::Unset, // malformed ⇒ fail-closed
    }
}

pub fn write_consent(data_dir: &Path, c: Consent) -> FolioResult<()> {
    let file = ConsentFile {
        consent: c.as_str().to_string(),
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| crate::error::FolioError::internal(e.to_string()))?;
    std::fs::write(consent_path(data_dir), json)
        .map_err(|e| crate::error::FolioError::internal(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_send_only_when_enabled() {
        assert!(should_send(Consent::Enabled));
        assert!(!should_send(Consent::Disabled));
        assert!(!should_send(Consent::Unset));
    }

    #[test]
    fn absent_file_is_unset() {
        let dir =
            std::env::temp_dir().join(format!("folio-analytics-absent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(consent_path(&dir));
        assert_eq!(read_consent(&dir), Consent::Unset);
    }

    #[test]
    fn malformed_file_is_unset() {
        let dir = std::env::temp_dir().join(format!("folio-analytics-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(consent_path(&dir), b"not json").unwrap();
        assert_eq!(read_consent(&dir), Consent::Unset);
    }

    #[test]
    fn round_trip_enabled_then_disabled() {
        let dir = std::env::temp_dir().join(format!("folio-analytics-rt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_consent(&dir, Consent::Enabled).unwrap();
        assert_eq!(read_consent(&dir), Consent::Enabled);
        write_consent(&dir, Consent::Disabled).unwrap();
        assert_eq!(read_consent(&dir), Consent::Disabled);
    }
}
