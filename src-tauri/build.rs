fn main() {
    // The Aptabase app key is baked in at compile time via
    // `option_env!("FOLIO_APTABASE_KEY")` (see src/analytics.rs). Without this
    // directive Cargo would not recompile when the key changes, silently
    // reusing a stale/empty key across builds.
    println!("cargo:rerun-if-env-changed=FOLIO_APTABASE_KEY");
    tauri_build::build()
}
