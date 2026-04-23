# Third-Party Licenses

Folio is released under the MIT License (see [`LICENSE`](./LICENSE)). It links
against or bundles the following third-party components. Each entry below
credits the upstream project, states how Folio uses it, and points at the
canonical license text.

The full text of every license referenced here is available at
<https://opensource.org/licenses> and mirrored by the upstream projects.

Rust crate dependencies are enumerated with their licenses in
[`Cargo.lock`](./Cargo.lock); JavaScript dependencies in
[`package-lock.json`](./package-lock.json). The entries below call out only
the components that affect distribution — native libraries that Folio links
to or ships in its release artifacts.

---

## libmobi

- **Upstream:** <https://github.com/bfabiszewski/libmobi>
- **License:** GNU Lesser General Public License v3.0 or later (LGPL-3.0-or-later)
- **License text:** <https://www.gnu.org/licenses/lgpl-3.0.html>
- **How Folio uses it:** Dynamically linked at runtime to parse MOBI / AZW /
  AZW3 (KF8) ebook files. Enabled when Folio is built with the `mobi` cargo
  feature.
- **Platform availability:** MOBI support is compiled into **macOS and
  Linux** release builds only. **Windows** builds do not include MOBI
  support — libmobi has no first-class MSVC build path, so shipping it
  would require an MSYS2 / vcpkg pipeline that is out of scope for v1.
- **Distribution:** Folio does not currently bundle libmobi into its
  release artifacts. The macOS / Linux release builds link libmobi at
  process load time, so end users **must install libmobi before first
  launch** — without it, the app fails to start (not just MOBI open).
  Install from the system package manager:
  - macOS: `brew install libmobi`
  - Debian / Ubuntu: `sudo apt install libmobi0`
  - Fedora / RHEL: `sudo dnf install libmobi`

  This keeps the relinking clause of the LGPL trivially satisfied — users
  can swap in their own compatible build of libmobi without touching
  Folio. Bundling libmobi inside the `.app` / `.AppImage` / `.deb` (with
  `install_name_tool` rewriting for macOS) is tracked as future work.

### LGPL compliance notes

LGPL v3+ permits dynamic linking from MIT-licensed applications, subject to
these obligations — all satisfied by the dynamic-linking layout described
above:

1. **Attribution.** This file and the in-app About screen identify libmobi,
   its license, and its upstream source.
2. **License availability.** The LGPL v3 text is available at the link
   above and is reproduced in the upstream libmobi repository's `COPYING`
   file.
3. **Source availability.** libmobi's source is published on GitHub at the
   upstream URL; anyone wishing to rebuild or modify the library can obtain
   it there. Folio does not carry a fork.
4. **Relinking.** Because libmobi is dynamically linked, a user may replace
   the shipped shared library with their own compatible build of libmobi
   without modifying Folio. No special re-linking support is required from
   the application beyond the dynamic-library layout.
5. **Modifications.** Folio does not modify libmobi. If that ever changes,
   the modified source will be published alongside the release.

---

## pdfium (Chromium PDF engine)

- **Upstream:** <https://pdfium.googlesource.com/pdfium/>
- **Binary distribution:** <https://github.com/bblanchon/pdfium-binaries>
- **License:** BSD-3-Clause (Folio uses the Chromium-style "New BSD" license
  text)
- **License text:** <https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE>
- **How Folio uses it:** Dynamically linked to render PDF pages into
  bitmaps for the Reader. Bindings are provided by the
  [`pdfium-render`](https://crates.io/crates/pdfium-render) Rust crate.
- **Distribution:** Release builds bundle the pdfium shared library in
  `src-tauri/resources/`, fetched at build time by
  [`scripts/download-pdfium.sh`](./scripts/download-pdfium.sh).

---

## unrar / unrar_sys

- **Upstream:** <https://www.rarlab.com/rar_add.htm> (via the
  [`unrar`](https://crates.io/crates/unrar) Rust crate)
- **License:** The UnRAR source is distributed under the **UnRAR license**,
  which permits use for decompression but explicitly forbids using the
  source to develop RAR-compatible compression tools. Folio only reads RAR
  / CBR archives, so this restriction is not at issue.
- **License text:** Included in the upstream source and reproduced in the
  `unrar_sys` crate.
- **How Folio uses it:** Statically linked for CBR (comic book RAR) archive
  support.

---

## Other notable Rust crates

The following crates ship compiled code in the Folio binary. Full license
metadata is in `Cargo.lock`; a quick summary of the major runtime
dependencies:

- `tauri`, `tauri-plugin-*` — Apache-2.0 / MIT
- `tokio`, `axum`, `reqwest`, `serde`, `rusqlite`, `r2d2`, `opendal`,
  `zip`, `quick-xml`, `ammonia`, `image` — Apache-2.0 / MIT (dual)
- `pdfium-render` — MIT / Apache-2.0
- `bindgen` (build dependency only) — BSD-3-Clause

---

## JavaScript / TypeScript dependencies

Frontend dependencies (React, Tailwind CSS, DOMPurify, etc.) are documented
in `package.json` / `package-lock.json`. All ship under permissive licenses
(MIT, BSD-3-Clause, Apache-2.0). Tailwind CSS icon sets and fonts bundled
in the app are MIT or SIL Open Font Licensed.

---

## Reporting an omission

If you believe a dependency is missing from this file or that the
attribution is incomplete, please open an issue at the Folio repository
with the component name and a pointer to its license.
