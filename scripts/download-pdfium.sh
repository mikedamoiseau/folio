#!/usr/bin/env bash
# Downloads pre-built pdfium binaries for all supported platforms into src-tauri/resources/.
# Skips a file if it already exists.
set -euo pipefail

RELEASE_TAG=$(curl -sf "https://api.github.com/repos/bblanchon/pdfium-binaries/releases/latest" \
  | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": "\(.*\)".*/\1/')
ENCODED_TAG="${RELEASE_TAG//\//%2F}"
BASE_URL="https://github.com/bblanchon/pdfium-binaries/releases/download/${ENCODED_TAG}"
RESOURCES_DIR="$(cd "$(dirname "$0")/../src-tauri/resources" && pwd)"

download_and_extract() {
  local archive="$1"
  local lib_path="$2"
  local dest="$3"

  if [ -f "$dest" ]; then
    echo "  already exists: $dest"
    return
  fi

  echo "  downloading $archive..."
  local tmp
  tmp=$(mktemp -d)
  curl -sL -o "$tmp/$archive" "${BASE_URL}/${archive}"
  tar -xzf "$tmp/$archive" -C "$tmp" "$lib_path"
  cp "$tmp/$lib_path" "$dest"
  rm -rf "$tmp"
  echo "  -> $dest"
}

echo "Downloading pdfium binaries (release: $RELEASE_TAG)..."

download_and_extract "pdfium-mac-univ.tgz"  "lib/libpdfium.dylib" "$RESOURCES_DIR/libpdfium.dylib"
download_and_extract "pdfium-linux-x64.tgz" "lib/libpdfium.so"    "$RESOURCES_DIR/libpdfium.so"
download_and_extract "pdfium-win-x64.tgz"   "bin/pdfium.dll"      "$RESOURCES_DIR/pdfium.dll"

echo "Done."
