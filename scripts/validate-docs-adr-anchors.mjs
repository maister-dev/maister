#!/usr/bin/env node
// Validates every cross-file ADR anchor link under docs/ against the actual
// `### ADR-NNN: …` headers in docs/decisions.md. Catches the class where prose
// cites an ADR that was never written (dead `decisions.md#adr-NNN-…` anchor) or
// squats a number whose header has a different title (anchor slug mismatch).
//
// Default mode: only files changed vs HEAD (working tree + staged + untracked).
// --all: walk every docs/**/*.md.
// Exit 2 on failure so a Claude Stop hook can block.

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const docsRoot = join(repoRoot, "docs");
const decisionsPath = join(docsRoot, "decisions.md");
const wantAll = process.argv.slice(2).includes("--all");

// GitHub heading-slug algorithm: lowercase, drop every character that is not a
// letter, digit, space, or hyphen, then convert each remaining space to a
// hyphen. Punctuation between two spaces collapses to a double hyphen — this
// matches the anchors GitHub/the existing docs already link to.
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}

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

// Build the set of valid `#adr-…` anchors from decisions.md headers.
const headingRe = /^#{2,6}\s+(ADR-\d+:.*)$/gm;
const validAnchors = new Set();
const knownAdrNumbers = new Set();
{
  const src = readFileSync(decisionsPath, "utf8");
  let m;
  while ((m = headingRe.exec(src)) !== null) {
    const heading = m[1];
    validAnchors.add(slugify(heading));
    const num = /ADR-(\d+)/.exec(heading);
    if (num) knownAdrNumbers.add(num[1]);
  }
}

// Match markdown links pointing at a decisions.md ADR anchor, from any doc, plus
// in-file `(#adr-…)` links inside decisions.md itself (the index table).
//   [label](path/to/decisions.md#adr-063-…)   |   [label](#adr-063-…)
const linkRe = /\]\((?:[^()#]*\bdecisions\.md)?#(adr-[a-z0-9-]+)\)/gi;

const targets = wantAll ? walkMd(docsRoot) : changedDocsFiles();
if (targets.length === 0) {
  console.log("validate-docs-adr-anchors: no docs/*.md changes detected");
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
    const anchor = m[1].toLowerCase();
    checked += 1;
    const bare = /^adr-(\d+)$/.exec(anchor);

    // Bare `#adr-NNN` is the repo's citation shorthand — accept it as long as
    // ADR-NNN exists. A full-title anchor `#adr-NNN-<slug>` must match a header
    // slug exactly (this is what catches a missing ADR or a number squatting a
    // header with a different title).
    if (bare ? knownAdrNumbers.has(bare[1]) : validAnchors.has(anchor)) {
      continue;
    }
    const line = src.slice(0, m.index).split("\n").length;
    const num = /^adr-(\d+)/.exec(anchor);
    const hint =
      num && !knownAdrNumbers.has(num[1])
        ? `ADR-${num[1]} has no \`### ADR-${num[1]}: …\` header in decisions.md`
        : `no ADR header slugifies to this anchor (wrong title/number?)`;
    failures.push({ file: relative(repoRoot, file), line, anchor, hint });
  }
}

if (failures.length === 0) {
  console.log(
    `validate-docs-adr-anchors: ${checked} ADR anchor link(s) resolved across ${targets.length} file(s)`,
  );
  process.exit(0);
}

console.error(`validate-docs-adr-anchors: ${failures.length} broken ADR anchor(s):`);
for (const f of failures) {
  console.error(`  ${f.file}:${f.line}  -> #${f.anchor}`);
  console.error(`    ${f.hint}`);
}
console.error(
  `\nFix the links above (or add the missing ADR to docs/decisions.md) and re-run ` +
    `\`pnpm validate:docs\`. To check every file regardless of git status, run ` +
    `\`pnpm validate:docs:all\`.`,
);
process.exit(2);
