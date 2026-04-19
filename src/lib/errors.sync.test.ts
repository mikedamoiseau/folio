// @ts-expect-error vitest runs under node; tsconfig has no node types
import { readdirSync, readFileSync, statSync } from "node:fs";
// @ts-expect-error vitest runs under node; tsconfig has no node types
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { MESSAGE_KEYS } from "./errors";

// __dirname is available at runtime under vitest (node).
declare const __dirname: string;

function collectRustSources(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            collectRustSources(full, acc);
        } else if (name.endsWith(".rs")) {
            acc.push(full);
        }
    }
    return acc;
}

// Substrings we deliberately allow without a matching Rust source reference.
// These come from third-party libraries (reqwest, zip, unrar, std::io) or from
// OS-level error messages. Adding them here acknowledges that the wording is
// outside our control — if one of these libraries updates its error text,
// translations will silently fall back to the raw message until we update.
const ALLOWED_WITHOUT_RUST_MATCH = new Set<string>([
    "request timed out",
    "connection refused",
    "connection reset",
    "dns error",
    "no such file or directory", // std::io::Error (Unix) wording
    "invalid format", // third-party parser wording
    "network error", // generic reqwest/opendal wording
    "could not find eocd", // zip crate
    "not a valid rar", // unrar crate
]);

describe("MESSAGE_KEYS / Rust source sync", () => {
    it("every substring appears in the Rust backend", () => {
        const rustRoot = resolve(__dirname, "../../src-tauri/src");
        const files = collectRustSources(rustRoot);
        const combined = files
            .map((f) => readFileSync(f, "utf8").toLowerCase())
            .join("\n");

        const missing: string[] = [];
        for (const substring of Object.keys(MESSAGE_KEYS)) {
            if (ALLOWED_WITHOUT_RUST_MATCH.has(substring)) continue;
            if (!combined.includes(substring.toLowerCase())) {
                missing.push(substring);
            }
        }

        expect(
            missing,
            `MESSAGE_KEYS entries not found in Rust source: ${missing.join(", ")}. ` +
                `Either the Rust wording drifted (update the key) or the entry is obsolete (remove it). ` +
                `If the substring genuinely comes from a third-party lib, add it to ALLOWED_WITHOUT_RUST_MATCH.`,
        ).toEqual([]);
    });
});
