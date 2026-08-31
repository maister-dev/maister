#!/usr/bin/env node
// Validates every relative markdown link under docs/ against the filesystem.
// Catches the class where a doc links a moved/deleted file or forgets the
// `../` prefix (docs/CLAUDE.md §Validation advertised a link gate that never
// existed — this is it).
//
// Checked: inline `[label](target)` links whose target is a relative path.
// Skipped: scheme links (http/https/mailto/…), protocol-relative `//`,
// pure `#fragment` links, and absolute `/app/route` targets (those are HTTP
// route illustrations, not files). Fragments/queries are stripped; targets
// are URI-decoded before resolution; a target may be a file or a directory.
//
// Default mode: only files changed vs HEAD (working tree + staged + untracked).
// --all: walk every docs/**/*.md.
// Exit 2 on failure so a Claude Stop hook can block.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const docsRoot = join(repoRoot, "docs");
const wantAll = process.argv.slice(2).includes("--all");

function walkMd(dir) {
  const out = [];
  for (const ent of readdirSync(dir)) {
    if (ent.startsWith(".")) continue;
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkMd(full));
    else if (full.endsWith(".md")) out.push(full);
  }
  return out;
}

function gitLines(cmd) {
  try {
    return execSync(cmd, { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function changedDocsFiles() {
  const tracked = gitLines("git diff --name-only --diff-filter=ACMR -- docs/");
  const staged = gitLines(
    "git diff --cached --name-only --diff-filter=ACMR -- docs/",
  );
  const untracked = gitLines(
    "git ls-files --others --exclude-standard -- docs/",
  );
  return [...new Set([...tracked, ...staged, ...untracked])]
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(repoRoot, f));
}

// Inline markdown links: `](target)` with an optional `"title"` and optional
// angle brackets. Stops at the first `)` — exactly how GitHub parses them, so
// an unescaped `(` in a path is (correctly) reported broken.
const linkRe = /\]\(<?([^)<>\s]+)>?(?:\s+"[^"]*")?\)/g;

function isCheckable(target) {
  if (target.startsWith("#")) return false; // in-page fragment
  if (target.startsWith("//")) return false; // protocol-relative
  if (target.startsWith("/")) return false; // HTTP route illustration
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false; // scheme (http, mailto…)
  return true;
}

const targets = wantAll ? walkMd(docsRoot) : changedDocsFiles();
if (targets.length === 0) {
  console.log("validate-docs-links: no docs/*.md changes detected");
  process.exit(0);
}

const failures = [];
let checked = 0;

for (const file of targets) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  let m;
  while ((m = linkRe.exec(src)) !== null) {
    const raw = m[1];
    if (!isCheckable(raw)) continue;

    let pathPart = raw.split("#")[0].split("?")[0];
    if (pathPart === "") continue; // `file.md#anchor` handled by the ADR gate

    try {
      pathPart = decodeURIComponent(pathPart);
    } catch {
      // keep the raw form; existence check below will report it
    }

    checked += 1;
    const resolved = resolve(dirname(file), pathPart);

    if (existsSync(resolved)) continue;

    const line = src.slice(0, m.index).split("\n").length;
    failures.push({ file: relative(repoRoot, file), line, target: raw });
  }
}

if (failures.length === 0) {
  console.log(
    `validate-docs-links: ${checked} relative link(s) resolved across ${targets.length} file(s)`,
  );
  process.exit(0);
}

console.error(`validate-docs-links: ${failures.length} broken link(s):`);
for (const f of failures) {
  console.error(`  ${f.file}:${f.line}  -> ${f.target}`);
}
console.error(
  `\nFix the links above and re-run \`pnpm validate:docs\`. To check every ` +
    `file regardless of git status, run \`pnpm validate:docs:all\`.`,
);
process.exit(2);
