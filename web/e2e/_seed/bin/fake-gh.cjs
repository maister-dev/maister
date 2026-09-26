// ADR-181 T4.1: the PR provider boundary for the workbench-git e2e smoke — a
// fake `gh` on the dev server's PATH (C16: a local Gitea is unreachable, the
// Gitea adapter forces https and drops the port). It answers exactly the calls
// the GhCliAdapter makes and records every create in a JSON state file the
// spec reads back. No network, no token check beyond presence.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const statePath = process.env.MAISTER_E2E_FAKE_GH_STATE;
const argv = process.argv.slice(2);

function flag(name) {
  const at = argv.indexOf(name);

  return at >= 0 ? argv[at + 1] : undefined;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { prs: [], creates: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

if (argv[0] === "--version") {
  process.stdout.write("gh version 0.0.0-e2e (fake)\n");
  process.exit(0);
}

if (!statePath) {
  process.stderr.write("fake gh: MAISTER_E2E_FAKE_GH_STATE is not set\n");
  process.exit(2);
}

if (argv[0] === "pr" && argv[1] === "list") {
  const head = flag("--head");
  const base = flag("--base");
  const open = readState()
    .prs.filter((pr) => pr.head === head && pr.base === base && pr.open)
    .map((pr) => ({ url: pr.url, number: pr.number, baseRefName: pr.base }));

  process.stdout.write(`${JSON.stringify(open)}\n`);
  process.exit(0);
}

if (argv[0] === "pr" && argv[1] === "create") {
  const state = readState();
  const number = state.prs.length + 1;
  const pr = {
    number,
    url: `https://github.com/maister-e2e/workbench-git/pull/${number}`,
    head: flag("--head"),
    base: flag("--base"),
    title: flag("--title"),
    draft: argv.includes("--draft"),
    open: true,
  };

  state.prs.push(pr);
  state.creates.push({
    head: pr.head,
    base: pr.base,
    title: pr.title,
    draft: pr.draft,
  });
  writeState(state);
  process.stdout.write(`${pr.url}\n`);
  process.exit(0);
}

process.stderr.write(`fake gh: unsupported call: ${argv.join(" ")}\n`);
process.exit(1);
