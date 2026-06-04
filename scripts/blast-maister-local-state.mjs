#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONFIRMATION = "BLAST_MAISTER_LOCAL_STATE";

function readArgValue(args, name) {
  const index = args.indexOf(name);

  if (index === -1) return null;

  return args[index + 1] ?? "";
}

function hasArg(args, name) {
  return args.includes(name);
}

function expandHome(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));

  return input;
}

function absolutePath(input) {
  return path.resolve(expandHome(input));
}

function maisterHome() {
  return absolutePath(process.env.MAISTER_HOME ?? path.join(os.homedir(), ".maister"));
}

function reposRoot() {
  return absolutePath(
    process.env.MAISTER_REPOS_ROOT ?? path.join(maisterHome(), "repos"),
  );
}

function worktreesRoot() {
  return absolutePath(
    process.env.MAISTER_WORKTREES_ROOT ??
      process.env.MAISTER_WORKTREE_ROOT ??
      path.join(maisterHome(), "worktrees"),
  );
}

function candidateRoots(repoCwd) {
  const roots = [
    worktreesRoot(),
    path.join(maisterHome(), "cache"),
    path.join(maisterHome(), "capabilities"),
    path.join(maisterHome(), "flows"),
    path.join(maisterHome(), "runtime"),
    path.join(maisterHome(), "platform-runtime"),
  ];

  if (process.env.MAISTER_RUNTIME_ROOT) {
    roots.push(absolutePath(process.env.MAISTER_RUNTIME_ROOT));
  }

  return [...new Set(roots)].filter((root) => root !== repoCwd);
}

function assertSafeRoot(root, repoCwd) {
  const normalized = absolutePath(root);
  const homeRoot = maisterHome();
  const repoRoot = reposRoot();

  if (normalized === repoCwd) {
    throw new Error(`refusing to delete repository cwd: ${normalized}`);
  }
  if (normalized === repoRoot || normalized.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`refusing to delete MAIster repos root: ${normalized}`);
  }
  if (
    normalized !== homeRoot &&
    !normalized.startsWith(`${homeRoot}${path.sep}`) &&
    !normalized.includes(`${path.sep}.maister${path.sep}`)
  ) {
    throw new Error(`refusing to delete path outside MAIster-owned roots: ${normalized}`);
  }
}

async function removeRoot(root, dryRun) {
  if (dryRun) return;

  await fs.rm(root, { force: true, recursive: true });
}

async function resetPostgres(databaseUrl, dryRun) {
  if (!databaseUrl) {
    throw new Error("--reset-postgres requires DATABASE_URL");
  }

  const args = [
    databaseUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
  ];

  if (dryRun) {
    return;
  }

  await execFileAsync("psql", args);
}

async function removeSqlite(databaseUrl, dryRun, repoCwd) {
  if (!databaseUrl.startsWith("file:")) return;

  const dbPath = absolutePath(databaseUrl.slice("file:".length));

  assertSafeRoot(dbPath, repoCwd);
  await removeRoot(dbPath, dryRun);
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = readArgValue(args, "--confirm");
  const dryRun = confirm !== CONFIRMATION;
  const resetPostgresRequested = hasArg(args, "--reset-postgres");
  const repoCwd = process.cwd();
  const roots = candidateRoots(repoCwd);

  console.log("MAIster local destructive reset");
  console.log(`mode=${dryRun ? "dry-run" : "confirmed"}`);
  console.log(`confirmation=${CONFIRMATION}`);
  console.log(`repoCwd=${repoCwd}`);
  console.log(`reposRoot=${reposRoot()} (never deleted by this script)`);

  for (const root of roots) {
    assertSafeRoot(root, repoCwd);
    console.log(`${dryRun ? "would remove" : "remove"} ${root}`);
    await removeRoot(root, dryRun);
  }

  if (process.env.DATABASE_URL?.startsWith("file:")) {
    const sqlitePath = absolutePath(process.env.DATABASE_URL.slice("file:".length));

    console.log(`${dryRun ? "would remove sqlite db" : "remove sqlite db"} ${sqlitePath}`);
    await removeSqlite(process.env.DATABASE_URL, dryRun, repoCwd);
  }

  if (resetPostgresRequested) {
    console.log(
      `${dryRun ? "would reset postgres schema" : "reset postgres schema"} from DATABASE_URL`,
    );
    await resetPostgres(process.env.DATABASE_URL, dryRun);
  }

  console.log("Next steps after confirmed reset:");
  console.log("  pnpm --filter maister-web db:migrate");
  console.log("  pnpm --filter maister-web db:seed");
  console.log("  re-register local projects from MAIster UI");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
