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
const hubStubs = new Map(); // num -> { title, status }
{
  const src = readFileSync(decisionsPath, "utf8");
  let m;
  while ((m = headingRe.exec(src)) !== null) {
    const heading = m[1];
    validAnchors.add(slugify(heading));
    const num = /ADR-(\d+)/.exec(heading);
    if (num) knownAdrNumbers.add(num[1]);
  }
  const stubRe =
    /^### ADR-(\d{3}): ([^\n]+)\n\n\*\*Status:\*\* ([^\n]+)$/gm;
  while ((m = stubRe.exec(src)) !== null) {
    hubStubs.set(m[1], { title: m[2], status: m[3] });
  }
}

// --- Hub ↔ body-file contract (F2 split of decisions.md) ---------------------
// Every `### ADR-NNN:` hub stub must have `docs/decisions/adr-NNN.md`; every
// body file must have a hub stub; body `# ADR-NNN: <title>` and `**Status:**`
// must match the stub verbatim (the body is the source — edit it first, then
// mirror the stub). Runs in every mode (cheap, and stub/body drift must never
// slip through a changed-files run that touched only one side.)
const contractFailures = [];
{
  const decisionsDir = join(docsRoot, "decisions");
  const bodyFiles = new Set(
    readdirSync(decisionsDir).filter((f) => /^adr-\d{3}\.md$/.test(f)),
  );

  for (const [num, stub] of hubStubs) {
    const fileName = `adr-${num}.md`;
    if (!bodyFiles.has(fileName)) {
      contractFailures.push(
        `hub stub ADR-${num} has no body file docs/decisions/${fileName}`,
      );
      continue;
    }
    bodyFiles.delete(fileName);
    const body = readFileSync(join(decisionsDir, fileName), "utf8");
    const titleM = /^# ADR-(\d{3}): ([^\n]+)$/m.exec(body);
    const statusM = /^\*\*Status:\*\* ([^\n]+)$/m.exec(body);
    if (!titleM || titleM[2] !== stub.title) {
      contractFailures.push(
        `docs/decisions/${fileName}: title differs from the hub stub ("${titleM?.[2] ?? "<missing>"}" vs "${stub.title}")`,
      );
    }
    // Body statuses point at the hub (`../decisions.md#adr-…`); stub statuses
    // link in-file (`#adr-…`). Normalize before comparing.
    const bodyStatus = (statusM?.[1] ?? "<missing>").replaceAll(
      "../decisions.md#",
      "#",
    );
    if (bodyStatus !== stub.status) {
      contractFailures.push(
        `docs/decisions/${fileName}: **Status:** differs from the hub stub ("${bodyStatus}" vs "${stub.status}")`,
      );
    }
  }
  for (const orphan of bodyFiles) {
    contractFailures.push(
      `docs/decisions/${orphan} has no matching ADR stub in decisions.md`,
    );
  }
}

if (contractFailures.length > 0) {
  console.error(
    `validate-docs-adr-anchors: ${contractFailures.length} hub/body contract violation(s):`,
  );
  for (const f of contractFailures) console.error(`  ${f}`);
  process.exit(2);
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
    `validate-docs-adr-anchors: ${checked} ADR anchor link(s) resolved across ${targets.length} file(s); ${hubStubs.size} hub stub(s) ↔ body files in sync`,
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
