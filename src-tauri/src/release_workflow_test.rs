//! Compile-time guards on `.github/workflows/release.yml`.
//!
//! The matrix combines platform targets with feature flags; regressions
//! here only surface at tag-push time, which is too late. These tests
//! assert the invariants we rely on:
//!
//! * Linux + arm64 macOS ship with `--features mobi`.
//! * x86_64 macOS must not enable `mobi` — the macos-latest runner is
//!   arm64, so Homebrew installs an arm64 `libmobi.dylib`. Cross-
//!   linking that into an `x86_64-apple-darwin` target fails at the
//!   linker step ("building for macOS-x86_64 but attempting to link
//!   with file built for macOS-arm64"). Until we ship a universal
//!   libmobi (or drop x86_64 Mac entirely), Intel-Mac users get
//!   EPUB/PDF/CBZ/CBR only.
//! * Windows still uses `--no-default-features` — libmobi has no
//!   first-class MSVC build path.

#[cfg(test)]
mod tests {
    const RELEASE_YML: &str = include_str!("../../.github/workflows/release.yml");

    /// Locate the single `args: '…'` matrix line that contains `needle`
    /// and return the whole line. We do string scanning instead of
    /// pulling in a YAML crate because the workspace doesn't otherwise
    /// need one — the structure we care about is stable and easy to
    /// pattern-match. Lines are filtered to those starting with
    /// `args: '` so surrounding YAML comments can't masquerade as matrix
    /// entries.
    fn args_for(needle: &str) -> &'static str {
        let mut matches = RELEASE_YML
            .lines()
            .filter(|l| l.trim_start().starts_with("args: '"))
            .filter(|l| l.contains(needle));
        let hit = matches
            .next()
            .unwrap_or_else(|| panic!("release.yml has no `args: '…'` line containing `{needle}`"));
        assert!(
            matches.next().is_none(),
            "release.yml has multiple `args: '…'` lines containing `{needle}`; needle is ambiguous"
        );
        hit
    }

    #[test]
    fn linux_build_enables_mobi_feature() {
        let line = args_for("tauri.linux.mobi.conf.json");
        assert!(
            line.contains("--features mobi"),
            "Linux build must enable --features mobi, got: {line}"
        );
    }

    #[test]
    fn aarch64_macos_build_enables_mobi_feature() {
        let line = args_for("aarch64-apple-darwin");
        assert!(
            line.contains("--features mobi"),
            "aarch64 macOS build must enable --features mobi, got: {line}"
        );
    }

    #[test]
    fn x86_64_macos_build_does_not_enable_mobi_feature() {
        // Regression guard: `--features mobi` on x86_64 + arm64 runner
        // fails to link against the arm64 libmobi.dylib Homebrew ships.
        // Flipping this back on requires also producing an x86_64 libmobi
        // (universal dylib, manual build, or Rosetta-cross-install).
        let line = args_for("x86_64-apple-darwin");
        assert!(
            !line.contains("--features mobi"),
            "x86_64 macOS build must NOT enable --features mobi — Homebrew's \
             libmobi is arm64 on macos-latest runners and fails to link into \
             an x86_64 target. Got: {line}"
        );
    }

    #[test]
    fn windows_build_disables_default_features() {
        let line = args_for("-- --no-default-features");
        assert!(
            line.contains("--no-default-features"),
            "Windows build must keep --no-default-features (no sftp, no mobi)"
        );
    }
}
