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
//! * Windows builds libmobi from source via CMake + MSVC (libmobi has
//!   first-class CMake support since v0.10) with `USE_ZLIB=OFF` and
//!   `USE_LIBXML2=OFF` so the build has no external deps to satisfy.
//!   The libmobi artifact is cached so a rerun on an unchanged pin is
//!   fast.

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
            "Windows build must keep --no-default-features (sftp incompatible with Windows build)"
        );
    }

    /// Pinning the libmobi commit/tag is what makes the cache deterministic.
    /// If the pin disappears, every CI run rebuilds from `master` and the
    /// cache key collapses to whatever the last run produced.
    #[test]
    fn windows_libmobi_version_is_pinned() {
        assert!(
            RELEASE_YML.contains("LIBMOBI_VERSION:"),
            "release.yml must define a `LIBMOBI_VERSION` env var so the \
             Windows libmobi build is reproducible and cache-keyable. \
             Without a pinned version, every push rebuilds from libmobi's \
             moving `master` branch."
        );
    }

    /// Each build of libmobi from source on a stock Windows runner takes
    /// minutes; without an actions/cache step keyed on version + arch the
    /// release workflow would pay that cost on every tag push. The test
    /// asserts the cache key includes both so an unchanged pin re-uses
    /// the artifact.
    #[test]
    fn windows_libmobi_build_is_cached() {
        let cache_block = "libmobi-${{ env.LIBMOBI_VERSION }}-windows-x64";
        assert!(
            RELEASE_YML.contains(cache_block),
            "release.yml must cache the Windows libmobi build under a key \
             that includes both the pinned version and the target arch — \
             expected substring `{cache_block}` not found. Without this \
             cache, every tag push spends minutes rebuilding libmobi from \
             source on the Windows runner."
        );
    }

    /// The libmobi build step must be Windows-only — it uses CMake +
    /// MSVC and would error or duplicate work if it ran on the
    /// Linux/macOS matrix entries.
    #[test]
    fn windows_libmobi_build_step_is_windows_only() {
        let needle = "Build libmobi (Windows)";
        assert!(
            RELEASE_YML.contains(needle),
            "release.yml must include a step named `{needle}` so the \
             Windows libmobi build path is auditable from the workflow at \
             a glance. The step itself gates on `matrix.platform == \
             'windows-latest'` to keep it off the Unix runners."
        );
        // The step's `if:` guard is the actual gating mechanism — a missing
        // guard would silently run the libmobi build on every matrix entry.
        let after_marker = RELEASE_YML.split_once(needle).expect("checked above").1;
        let next_300 = &after_marker[..after_marker.len().min(300)];
        assert!(
            next_300.contains("matrix.platform == 'windows-latest'"),
            "the `{needle}` step must be gated on \
             `matrix.platform == 'windows-latest'` — without the guard it \
             would also run on the Linux/macOS matrix entries and fail \
             (no MSVC toolchain). Got: {next_300}"
        );
    }
}
