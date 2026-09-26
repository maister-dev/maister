// ADR-181 T4.1: the PR provider boundary for the workbench-git e2e smoke — a
// fake `gh` on the dev server's PATH (C16: a local Gitea is unreachable, the
// Gitea adapter forces https and drops the port). It answers exactly the calls
// the GhCliAdapter and the PR-state read make, and records every create and
// every view in a JSON state file the spec reads back. No network, no token
// check beyond presence.
"use strict";

const { execFileSync } = require("node:child_process");
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
    return { prs: [], creates: [], views: [] };
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
    // The adapter runs `gh` in the parent checkout; its origin is the remote
    // the PR's branch lives on.
    repoPath: process.cwd(),
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

// `gh pr view <n> --repo <owner/repo> --json …`: the PR as GitHub reports it.
// Its head (`headRefOid`) is the PR branch's tip on the remote, which is what a
// finalize binds to (ADR-181, Codex F5).
if (argv[0] === "pr" && argv[1] === "view") {
  const state = readState();
  const number = Number(argv[2]);
  const pr = state.prs.find((candidate) => candidate.number === number);

  if (!pr) {
    process.stderr.write(`no pull requests found for #${argv[2]}\n`);
    process.exit(1);
  }

  const tip = execFileSync(
    "git",
    ["-C", pr.repoPath, "ls-remote", "origin", `refs/heads/${pr.head}`],
    { encoding: "utf8" },
  ).split(/\s/)[0];

  state.views = [...(state.views ?? []), number];
  writeState(state);
  process.stdout.write(
    `${JSON.stringify({
      state: pr.open ? "OPEN" : "CLOSED",
      mergedAt: null,
      mergeCommit: null,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefOid: tip || null,
    })}\n`,
  );
  process.exit(0);
}

process.stderr.write(`fake gh: unsupported call: ${argv.join(" ")}\n`);
process.exit(1);
