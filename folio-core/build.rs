//! Build script for folio-core.
//!
//! When the `mobi` feature is enabled (default), we locate libmobi via
//! pkg-config, tell cargo how to link against it, and generate Rust FFI
//! bindings from `mobi.h` into `$OUT_DIR/libmobi_bindings.rs`.

use std::env;
use std::path::PathBuf;

fn main() {
    if env::var_os("CARGO_FEATURE_MOBI").is_some() {
        build_libmobi_bindings();
    }
}

fn build_libmobi_bindings() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    println!("cargo:rerun-if-env-changed=LIBMOBI_INCLUDE_DIR");
    println!("cargo:rerun-if-env-changed=LIBMOBI_LIB_DIR");

    let (include_paths, link_dir) = resolve_libmobi_paths();

    println!("cargo:rustc-link-lib=dylib=mobi");
    if let Some(dir) = link_dir {
        println!("cargo:rustc-link-search=native={}", dir.display());
    }

    let mut builder = bindgen::Builder::default()
        .header_contents("wrapper.h", "#include <mobi.h>")
        .allowlist_function("mobi_.*")
        .allowlist_type("MOBI.*")
        .allowlist_var("MOBI_.*")
        .derive_debug(true)
        .derive_default(true)
        .generate_comments(false)
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()));

    for path in &include_paths {
        builder = builder.clang_arg(format!("-I{}", path.display()));
    }

    let bindings = builder
        .generate()
        .expect("failed to generate libmobi bindings — is libmobi installed?");

    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap()).join("libmobi_bindings.rs");
    bindings
        .write_to_file(&out_path)
        .expect("failed to write libmobi_bindings.rs");
}

fn resolve_libmobi_paths() -> (Vec<PathBuf>, Option<PathBuf>) {
    if let Ok(lib) = pkg_config::Config::new().probe("libmobi") {
        let link_dir = lib.link_paths.into_iter().next();
        return (lib.include_paths, link_dir);
    }

    let include = env::var("LIBMOBI_INCLUDE_DIR").map(PathBuf::from).ok();
    let lib_dir = env::var("LIBMOBI_LIB_DIR").map(PathBuf::from).ok();
    (include.into_iter().collect(), lib_dir)
}
