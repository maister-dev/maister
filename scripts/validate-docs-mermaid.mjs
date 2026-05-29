#!/usr/bin/env node
// Validates every ```mermaid``` block under docs/ via mermaid.parse().
// Default mode: only files changed vs HEAD (working tree + staged + untracked).
// --all: walk every docs/**/*.md.
// Exit 2 on failure so a Claude Stop hook can block.

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.HTMLElement = dom.window.HTMLElement;

const { default: mermaid } = await import("mermaid");
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

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

const targets = wantAll ? walkMd(docsRoot) : changedDocsFiles();
if (targets.length === 0) {
  console.log("validate-docs-mermaid: no docs/*.md changes detected");
  process.exit(0);
}

const blockRe = /```mermaid\n([\s\S]*?)```/g;
const failures = [];
let passes = 0;
let blocks = 0;

for (const file of targets) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  let i = 0;
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    i += 1;
    blocks += 1;
    const startLine = src.slice(0, m.index).split("\n").length;
    try {
      await mermaid.parse(m[1]);
      passes += 1;
    } catch (err) {
      const msg = String(err?.message ?? err)
        .split("\n")
        .slice(0, 8)
        .join("\n");
      failures.push({
        file: relative(repoRoot, file),
        line: startLine,
        block: i,
        err: msg,
      });
    }
  }
}

if (failures.length === 0) {
  console.log(
    `validate-docs-mermaid: ${passes}/${blocks} mermaid block(s) passed across ${targets.length} file(s)`,
  );
  process.exit(0);
}

console.error(`validate-docs-mermaid: ${failures.length} failure(s):`);
for (const f of failures) {
  console.error(`  ${f.file}:${f.line}  (mermaid block #${f.block})`);
  console.error(`    ${f.err.replace(/\n/g, "\n    ")}`);
}
console.error(
  `\nFix the blocks above and re-run \`pnpm validate:docs\`. ` +
    `To check every file regardless of git status, run \`pnpm validate:docs:all\`.`,
);
process.exit(2);
