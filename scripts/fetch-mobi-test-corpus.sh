#!/usr/bin/env bash
# Fetch the MOBI test corpus used by folio-core's fixture-gated tests.
#
# The corpus lives under `src-tauri/test-fixtures/` (gitignored) and is
# pulled on demand rather than checked in — MOBI files are a few hundred
# KB each, but keeping a binary corpus in git quickly becomes a
# licensing and reviewability headache. Everything fetched here is in
# the public domain (Project Gutenberg).
#
# Files produced:
#   src-tauri/test-fixtures/alice.mobi         — KF8 (AZW3 / file version 8)
#   src-tauri/test-fixtures/alice-legacy.mobi  — legacy Mobipocket (version 6)
#
# Idempotent: an existing file with matching name is left alone so re-running
# the script after a partial network failure only fetches what's missing.
#
# Usage:
#   ./scripts/fetch-mobi-test-corpus.sh
#   FORCE=1 ./scripts/fetch-mobi-test-corpus.sh   # re-download existing files

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES_DIR="${REPO_ROOT}/src-tauri/test-fixtures"
mkdir -p "${FIXTURES_DIR}"

# Project Gutenberg IDs and file slugs. Alice's Adventures in Wonderland
# (PG #11) is the canonical test book — it has illustrations, a cover,
# multiple chapters, and is small enough to keep fixture runs fast.
#
# Project Gutenberg publishes both the KF8 and legacy variants under
# different suffixes. We keep the mapping explicit so a broken upstream
# URL shows up here rather than as a cryptic test failure.
# The `-kf8` suffix is load-bearing: `pg11-images.mobi` and
# `pg11-images-kf8.mobi` both resolve 200 OK at Gutenberg, but only the
# latter is KF8 / file-version 8 — the unsuffixed URL returns legacy
# Mobipocket v6 wrapped in a slightly newer header. The KF8 variant is
# what we actually need to exercise the AZW3 code paths, so we fetch
# the `-kf8` URL by name rather than relying on the redirect chain.
declare -a FILES=(
  "alice.mobi|https://www.gutenberg.org/cache/epub/11/pg11-images-kf8.mobi"
  "alice-legacy.mobi|https://www.gutenberg.org/cache/epub/11/pg11.mobi"
)

fetch_one() {
  local name="$1"
  local url="$2"
  local dest="${FIXTURES_DIR}/${name}"

  if [ -f "${dest}" ] && [ -z "${FORCE:-}" ]; then
    echo "  already present: ${name}"
    return
  fi

  echo "  downloading ${name} from ${url}"
  local tmp
  tmp="$(mktemp)"
  # -f: fail on 4xx/5xx; -L: follow redirects; -sS: silent but show errors.
  if ! curl -fLsS -o "${tmp}" "${url}"; then
    rm -f "${tmp}"
    echo "error: failed to download ${name} from ${url}" >&2
    echo "       — Project Gutenberg URLs occasionally change; inspect" >&2
    echo "       https://www.gutenberg.org/ebooks/11 and update the script." >&2
    exit 1
  fi

  # Cheap sanity check: MOBI files start with a 32-byte PalmDB header
  # whose bytes 60..64 spell one of BOOKMOBI / TEXtREAd. Reject
  # downloads that don't so a redirect-to-HTML or captive-portal page
  # can't silently land in test-fixtures/.
  local magic
  magic="$(dd if="${tmp}" bs=1 count=8 skip=60 2>/dev/null | tr -d '\0')"
  case "${magic}" in
    BOOKMOBI|TEXtREAd)
      ;;
    *)
      rm -f "${tmp}"
      echo "error: ${name} did not download as a MOBI file (magic: '${magic}')" >&2
      echo "       The URL may have redirected to an HTML landing page." >&2
      exit 1
      ;;
  esac

  mv "${tmp}" "${dest}"
  echo "  -> ${dest}"
}

echo "Fetching MOBI test corpus into ${FIXTURES_DIR}"
for entry in "${FILES[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  fetch_one "${name}" "${url}"
done
echo "Done."
