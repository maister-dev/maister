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

// ADR-165: the supervisor-private execution-host state store (host identity,
// fences, adopted-workspace handles, receipts). Defaults under the runtime
// root's .maister/, which is the supervisor cwd when MAISTER_RUNTIME_ROOT is
// unset — the repo checkout itself is never deleted, but its .maister/ state is.
function executionHostStateDir(repoCwd) {
  if (process.env.MAISTER_EXECUTION_HOST_STATE_DIR) {
    return absolutePath(process.env.MAISTER_EXECUTION_HOST_STATE_DIR);
  }
  const runtimeRoot = process.env.MAISTER_RUNTIME_ROOT
    ? absolutePath(process.env.MAISTER_RUNTIME_ROOT)
    : repoCwd;

  return path.join(runtimeRoot, ".maister", "execution-host");
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

  const stateDir = executionHostStateDir(repoCwd);

  try {
    assertSafeRoot(stateDir, repoCwd);
    roots.push(stateDir);
  } catch {
    // A custom state dir outside every MAIster-owned root is the operator's to
    // remove; refusing it must not abort the rest of the reset.
    console.log(
      `skip ${stateDir} (execution-host state dir outside MAIster-owned roots; remove it manually)`,
    );
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

function postgresUrlForReset(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("--reset-postgres requires DB_URL");
  }

  let parsed;

  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("--reset-postgres requires a valid Postgres DB_URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("--reset-postgres requires a postgres:// or postgresql:// DB_URL");
  }

  return databaseUrl;
}

async function resetPostgres(connectionUrl, dryRun) {
  const args = [
    connectionUrl,
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

async function main() {
  const args = process.argv.slice(2);
  const confirm = readArgValue(args, "--confirm");
  const dryRun = confirm !== CONFIRMATION;
  const resetPostgresRequested = hasArg(args, "--reset-postgres");
  const postgresResetUrl = resetPostgresRequested
    ? postgresUrlForReset(process.env.DB_URL)
    : null;
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

  if (postgresResetUrl) {
    console.log(
      `${dryRun ? "would reset postgres schema" : "reset postgres schema"} from DB_URL`,
    );
    await resetPostgres(postgresResetUrl, dryRun);
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
