//! Compile-time checks on the split Tauri bundle configuration.
//!
//! `tauri.conf.json` is the base config used by every build. Linux-only
//! runtime dependencies (`libmobi0` for `.deb`, `libmobi` for `.rpm`) are
//! pulled out into `tauri.linux.mobi.conf.json` and merged in via
//! `--config` only when the release workflow builds with `--features mobi`.
//!
//! These tests guard the split so a future edit can't silently
//! put the depends back into the base config (which would ship them in
//! `--no-default-features` Linux builds that don't actually link libmobi)
//! or strip them from the overlay (which would un-declare the dependency
//! on the shipping Linux path).

#[cfg(test)]
mod tests {
    use serde_json::Value;

    const BASE: &str = include_str!("../tauri.conf.json");
    const OVERLAY_MOBI_LINUX: &str = include_str!("../tauri.linux.mobi.conf.json");

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).expect("valid JSON")
    }

    #[test]
    fn base_config_has_no_linux_libmobi_depends() {
        // The base config must not carry Linux libmobi depends — those are
        // conditional on the `mobi` feature and live in the overlay so
        // non-mobi Linux builds produce honest package metadata.
        let base = parse(BASE);
        let linux = base.pointer("/bundle/linux");
        // `/bundle/linux` may exist for other reasons, but `.deb.depends`
        // and `.rpm.depends` must not be in the base.
        if let Some(linux) = linux {
            assert!(
                linux.pointer("/deb/depends").is_none(),
                "tauri.conf.json must not carry bundle.linux.deb.depends; \
                 those belong in tauri.linux.mobi.conf.json"
            );
            assert!(
                linux.pointer("/rpm/depends").is_none(),
                "tauri.conf.json must not carry bundle.linux.rpm.depends; \
                 those belong in tauri.linux.mobi.conf.json"
            );
        }
    }

    #[test]
    fn overlay_declares_libmobi_deb_depends() {
        let overlay = parse(OVERLAY_MOBI_LINUX);
        let depends = overlay
            .pointer("/bundle/linux/deb/depends")
            .expect("tauri.linux.mobi.conf.json must declare bundle.linux.deb.depends");
        let arr = depends.as_array().expect("depends must be an array");
        assert!(
            arr.iter().any(|v| v.as_str() == Some("libmobi0")),
            "Debian depends must include `libmobi0`, got {arr:?}"
        );
    }

    #[test]
    fn overlay_declares_libmobi_rpm_depends() {
        let overlay = parse(OVERLAY_MOBI_LINUX);
        let depends = overlay
            .pointer("/bundle/linux/rpm/depends")
            .expect("tauri.linux.mobi.conf.json must declare bundle.linux.rpm.depends");
        let arr = depends.as_array().expect("depends must be an array");
        assert!(
            arr.iter().any(|v| v.as_str() == Some("libmobi")),
            "RPM depends must include `libmobi`, got {arr:?}"
        );
    }

    #[test]
    fn overlay_is_schema_valid_for_tauri_merge() {
        // The overlay must have the `$schema` key so IDE tooling picks it up
        // and it parses under the Tauri v2 config schema — catches typos like
        // `bundles` vs `bundle`.
        let overlay = parse(OVERLAY_MOBI_LINUX);
        assert!(
            overlay.get("$schema").is_some(),
            "overlay must include $schema"
        );
        assert!(
            overlay.get("bundle").is_some(),
            "overlay root must be {{ bundle: ... }}"
        );
    }
}
