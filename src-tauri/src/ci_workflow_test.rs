//! Compile-time guards on `.github/workflows/ci.yml`.
//!
//! Mirrors the approach in `release_workflow_test.rs`: scan the YAML for
//! the structural invariants we depend on so a future edit can't quietly
//! drop them. Failures here surface at PR time instead of at the next
//! Windows MOBI release tag.
//!
//! Specifically:
//!
//! * A Windows MOBI test job must exist so regressions in the libmobi
//!   FFI / linker path show up on every PR, not just at release time.
//! * That job must build libmobi from source (Windows runners have no
//!   package manager that ships libmobi-dev) and pin the exact same
//!   `LIBMOBI_VERSION` env var the release workflow uses, so a single
//!   pin bump moves both pipelines together.

#[cfg(test)]
mod tests {
    const CI_YML: &str = include_str!("../../.github/workflows/ci.yml");

    /// The Linux smoke job is the authoritative MOBI test home (see the
    /// macOS comment in ci.yml). The Windows job is a *secondary* smoke
    /// path — its purpose is to catch MSVC + libmobi FFI regressions
    /// before they reach the release pipeline. Without this job, MSVC
    /// linker / bindgen breakage only surfaces at tag-push time.
    #[test]
    fn ci_has_windows_mobi_test_job() {
        assert!(
            CI_YML.contains("test-mobi-windows:"),
            "ci.yml must define a `test-mobi-windows` job so MSVC + \
             libmobi link/build regressions are caught on PRs rather \
             than at release time. Without it, the only Windows MOBI \
             coverage is the release.yml tag-push job — which discovers \
             breakage too late."
        );
    }

    /// The Windows MOBI test must run on a Windows runner — running it
    /// on ubuntu-latest would either pick up apt's libmobi (defeating
    /// the purpose of testing the MSVC path) or fail outright.
    #[test]
    fn windows_mobi_job_runs_on_windows_runner() {
        let after_marker = CI_YML
            .split_once("test-mobi-windows:")
            .expect("checked by ci_has_windows_mobi_test_job");
        // ~800 chars is enough to clear the leading job-level doc
        // comment block and reach the `runs-on:` declaration.
        let next_800 = &after_marker.1[..after_marker.1.len().min(800)];
        assert!(
            next_800.contains("runs-on: windows-latest"),
            "test-mobi-windows must declare `runs-on: windows-latest` \
             within its first ~800 chars (i.e. before any `steps:`). \
             Got:\n{next_800}"
        );
    }

    /// Both ci.yml and release.yml build libmobi from the same pinned
    /// upstream tag. If only one defines `LIBMOBI_VERSION`, a future
    /// pin bump in release.yml could leave the CI Windows job building
    /// against a different libmobi than the release does — masking
    /// MSVC regressions until tag-push.
    #[test]
    fn ci_pins_libmobi_version() {
        assert!(
            CI_YML.contains("LIBMOBI_VERSION:"),
            "ci.yml must define `LIBMOBI_VERSION` (matching release.yml) \
             so the Windows MOBI test job builds the same libmobi tag the \
             release pipeline ships. Without an explicit pin, the CI job \
             could mask MSVC-specific regressions in newer libmobi tags."
        );
    }

    /// CI must build libmobi the same way (static archive) the
    /// release does. A divergence here would mean PR CI exercises a
    /// configuration the release pipeline never ships against — the
    /// whole point of the Windows MOBI test job is to catch MSVC
    /// regressions before tag-push, and that only works if the
    /// build configs match.
    #[test]
    fn ci_libmobi_build_is_static() {
        assert!(
            CI_YML.contains("-DBUILD_SHARED_LIBS=OFF"),
            "ci.yml must build libmobi with `BUILD_SHARED_LIBS=OFF` \
             to match release.yml. A shared (DLL) build in CI vs a \
             static build in release would mean PR CI cannot catch \
             MSVC regressions in the static-link path the release \
             actually ships."
        );
    }

    /// The Windows MOBI build is expensive on a stock runner; without
    /// caching, every PR push pays the rebuild cost. The cache key in
    /// ci.yml must match release.yml exactly — including the build-
    /// flavor suffix — so the same artifact is reused across pipelines
    /// and a flavor change in either file surfaces as a mismatch in
    /// the cross-file drift test.
    #[test]
    fn ci_caches_windows_libmobi_build() {
        let cache_key = "libmobi-${{ env.LIBMOBI_VERSION }}-windows-x64-static-nozlib-nolibxml2-v1";
        assert!(
            CI_YML.contains(cache_key),
            "ci.yml must cache the Windows libmobi build under the same \
             flavor-encoded key release.yml uses (`{cache_key}`). \
             Mismatched keys would force separate rebuilds and could \
             let the CI cache drift to a different build flavor than \
             the one the release pipeline ships."
        );
    }
}
