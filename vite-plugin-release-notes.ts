import { readFileSync } from "fs";
import { resolve } from "path";
import type { Plugin } from "vite";

export interface ReleaseEntry {
  title: string;
  description: string;
}

export interface ReleaseVersion {
  version: string;
  date: string;
  categories: Record<string, ReleaseEntry[]>;
}

const VERSION_RE = /^## \[(.+?)\]\s*-\s*(.+)$/;
const CATEGORY_RE = /^### (.+)$/;
const ENTRY_RE = /^- \*\*(.+?)\*\*(.*)$/;
const PLAIN_ENTRY_RE = /^- (.+)$/;

export function parseChangelog(raw: string, maxVersions = 3): ReleaseVersion[] {
  const lines = raw.split("\n");
  const versions: ReleaseVersion[] = [];
  let current: ReleaseVersion | null = null;
  let currentCategory = "";

  for (const line of lines) {
    const versionMatch = line.match(VERSION_RE);
    if (versionMatch) {
      if (versionMatch[1] === "Unreleased") {
        current = null;
        continue;
      }
      if (versions.length >= maxVersions) break;
      current = {
        version: versionMatch[1],
        date: versionMatch[2].trim(),
        categories: {},
      };
      versions.push(current);
      currentCategory = "";
      continue;
    }

    if (!current) continue;

    const categoryMatch = line.match(CATEGORY_RE);
    if (categoryMatch) {
      currentCategory = categoryMatch[1];
      if (!current.categories[currentCategory]) {
        current.categories[currentCategory] = [];
      }
      continue;
    }

    if (!currentCategory) continue;

    const entryMatch = line.match(ENTRY_RE);
    if (entryMatch) {
      current.categories[currentCategory].push({
        title: entryMatch[1],
        description: entryMatch[2].replace(/^\s*[.\-—]\s*/, "").replace(/\.\s*$/, ".").trim(),
      });
      continue;
    }

    const plainMatch = line.match(PLAIN_ENTRY_RE);
    if (plainMatch && !line.startsWith("  ")) {
      current.categories[currentCategory].push({
        title: plainMatch[1].replace(/\.\s*$/, ".").trim(),
        description: "",
      });
    }
  }

  return versions;
}

export default function releaseNotesPlugin(): Plugin {
  const virtualModuleId = "virtual:release-notes";
  const resolvedId = "\0" + virtualModuleId;

  return {
    name: "vite-plugin-release-notes",
    resolveId(id) {
      if (id === virtualModuleId) return resolvedId;
    },
    load(id) {
      if (id !== resolvedId) return;

      const changelogPath = resolve(__dirname, "CHANGELOG.md");
      const raw = readFileSync(changelogPath, "utf-8");
      const notes = parseChangelog(raw, 3);

      const pkgPath = resolve(__dirname, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

      return `export const releaseNotes = ${JSON.stringify(notes)};
export const appVersion = ${JSON.stringify(pkg.version)};
`;
    },
  };
}
