use semver::Version;
use serde::{Deserialize, Serialize};

/// Static full-changelog target (never derived from GitHub data).
pub const CHANGELOG_URL: &str = "https://github.com/mikedamoiseau/folio/releases";

const RELEASE_TAG_PATH_PREFIX: &str = "/mikedamoiseau/folio/releases/tag/";

/// Minimal DTO. `body` is `Option` — GitHub release bodies can be null/absent;
/// deserializing into `String` would error a valid release.
#[derive(Debug, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    pub html_url: String,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateCheck {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub changelog_url: String,
    pub release_notes: String,
}

/// Pure seam: map a fetched release + installed version to `UpdateCheck`.
/// No network I/O. On failure returns the stable code `malformed_response`;
/// the underlying detail is logged, never returned to the frontend.
pub fn map_release(release: &GitHubRelease, current: &Version) -> Result<UpdateCheck, String> {
    let tag = release.tag_name.trim();
    let latest_str = tag.strip_prefix('v').unwrap_or(tag);
    let latest = Version::parse(latest_str).map_err(|e| {
        tracing::debug!(tag = %release.tag_name, error = %e, "update check: unparseable release tag");
        "malformed_response".to_string()
    })?;

    validate_release_url(&release.html_url)?;

    Ok(UpdateCheck {
        update_available: latest > *current,
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        release_url: release.html_url.clone(),
        changelog_url: CHANGELOG_URL.to_string(),
        release_notes: release.body.clone().unwrap_or_default(),
    })
}

/// Authoritative download-URL validation via a parsed URL — states the security
/// contract directly (scheme + exact host + path prefix) and avoids literal
/// string surprises (userinfo spoofing, case, normalization).
fn validate_release_url(raw: &str) -> Result<(), String> {
    let reject = || {
        tracing::warn!(url = raw, "update check: unexpected release url");
        "malformed_response".to_string()
    };
    let parsed = url::Url::parse(raw).map_err(|_| reject())?;
    if parsed.scheme() == "https"
        && parsed.host_str() == Some("github.com")
        && parsed.path().starts_with(RELEASE_TAG_PATH_PREFIX)
    {
        Ok(())
    } else {
        Err(reject())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use semver::Version;

    fn rel(tag: &str, body: Option<&str>) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_string(),
            html_url: "https://github.com/mikedamoiseau/folio/releases/tag/v2.8.0".to_string(),
            body: body.map(|b| b.to_string()),
        }
    }

    #[test]
    fn newer_patch_is_update() {
        let out = map_release(
            &rel("v2.8.0", Some("notes")),
            &Version::parse("2.7.0").unwrap(),
        )
        .unwrap();
        assert!(out.update_available);
        assert_eq!(out.latest_version, "2.8.0");
        assert_eq!(out.current_version, "2.7.0");
        assert_eq!(out.release_notes, "notes");
        assert_eq!(out.changelog_url, CHANGELOG_URL);
    }

    #[test]
    fn equal_version_is_not_update() {
        assert!(
            !map_release(&rel("v2.7.0", None), &Version::parse("2.7.0").unwrap())
                .unwrap()
                .update_available
        );
    }

    #[test]
    fn older_latest_is_not_update() {
        assert!(
            !map_release(&rel("2.6.0", None), &Version::parse("2.7.0").unwrap())
                .unwrap()
                .update_available
        );
    }

    #[test]
    fn tag_without_v_prefix_parses() {
        let out = map_release(&rel("2.9.0", None), &Version::parse("2.7.0").unwrap()).unwrap();
        assert_eq!(out.latest_version, "2.9.0");
        assert!(out.update_available);
    }

    #[test]
    fn surrounding_whitespace_trimmed() {
        assert_eq!(
            map_release(&rel("  v2.8.0 ", None), &Version::parse("2.7.0").unwrap())
                .unwrap()
                .latest_version,
            "2.8.0"
        );
    }

    #[test]
    fn uppercase_v_is_malformed() {
        assert_eq!(
            map_release(&rel("V2.8.0", None), &Version::parse("2.7.0").unwrap()).unwrap_err(),
            "malformed_response"
        );
    }

    #[test]
    fn null_body_becomes_empty_notes() {
        assert_eq!(
            map_release(&rel("v2.8.0", None), &Version::parse("2.7.0").unwrap())
                .unwrap()
                .release_notes,
            ""
        );
    }

    #[test]
    fn installed_prerelease_beats_stable_latest() {
        assert!(
            !map_release(
                &rel("v2.7.0", None),
                &Version::parse("2.8.0-beta.1").unwrap()
            )
            .unwrap()
            .update_available
        );
    }

    #[test]
    fn malformed_tag_is_malformed() {
        assert_eq!(
            map_release(
                &rel("not-a-version", None),
                &Version::parse("2.7.0").unwrap()
            )
            .unwrap_err(),
            "malformed_response"
        );
    }

    #[test]
    fn deceptive_host_rejected() {
        let mut r = rel("v2.8.0", None);
        r.html_url =
            "https://github.com.example.org/mikedamoiseau/folio/releases/tag/v2.8.0".into();
        assert_eq!(
            map_release(&r, &Version::parse("2.7.0").unwrap()).unwrap_err(),
            "malformed_response"
        );
    }

    #[test]
    fn http_scheme_rejected() {
        let mut r = rel("v2.8.0", None);
        r.html_url = "http://github.com/mikedamoiseau/folio/releases/tag/v2.8.0".into();
        assert_eq!(
            map_release(&r, &Version::parse("2.7.0").unwrap()).unwrap_err(),
            "malformed_response"
        );
    }

    #[test]
    fn wrong_path_prefix_rejected() {
        let mut r = rel("v2.8.0", None);
        r.html_url = "https://github.com/mikedamoiseau/folio/issues/1".into();
        assert_eq!(
            map_release(&r, &Version::parse("2.7.0").unwrap()).unwrap_err(),
            "malformed_response"
        );
    }

    #[test]
    fn userinfo_spoof_rejected() {
        let mut r = rel("v2.8.0", None);
        r.html_url = "https://github.com@evil.com/mikedamoiseau/folio/releases/tag/v2.8.0".into();
        assert_eq!(
            map_release(&r, &Version::parse("2.7.0").unwrap()).unwrap_err(),
            "malformed_response"
        );
    }
}
