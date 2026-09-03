import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("blast-maister-local-state dry-run does not remove MAIster roots", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maister-blast-test-"));
  const home = path.join(tmp, ".maister");
  const marker = path.join(home, "worktrees", "marker.txt");

  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, "keep", "utf8");

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/blast-maister-local-state.mjs"],
      {
        cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
        env: {
          ...process.env,
          MAISTER_HOME: home,
          MAISTER_REPOS_ROOT: path.join(home, "repos"),
        },
      },
    );

    assert.match(stdout, /mode=dry-run/);
    assert.match(stdout, /would remove/);
    assert.equal(await fs.readFile(marker, "utf8"), "keep");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("blast-maister-local-state covers the execution-host state dir and skips one outside MAIster roots", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maister-blast-test-"));
  const home = path.join(tmp, ".maister");
  // A runtime root the reset already owns (under MAISTER_HOME): the default
  // state dir nests under its .maister/.
  const runtimeRoot = path.join(home, "runtime-root");
  const stateDir = path.join(runtimeRoot, ".maister", "execution-host");
  const foreignStateDir = path.join(tmp, "elsewhere", "execution-host");
  const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(foreignStateDir, { recursive: true });

  try {
    const baseEnv = {
      ...process.env,
      MAISTER_HOME: home,
      MAISTER_REPOS_ROOT: path.join(home, "repos"),
    };
    // Default location: under <MAISTER_RUNTIME_ROOT>/.maister/ → listed.
    const withRuntimeRoot = await execFileAsync(
      process.execPath,
      ["scripts/blast-maister-local-state.mjs"],
      { cwd, env: { ...baseEnv, MAISTER_RUNTIME_ROOT: runtimeRoot } },
    );

    assert.match(withRuntimeRoot.stdout, /mode=dry-run/);
    assert.match(
      withRuntimeRoot.stdout,
      new RegExp(`would remove ${stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );

    // A custom dir outside every MAIster-owned root is skipped, not fatal.
    const foreign = await execFileAsync(
      process.execPath,
      ["scripts/blast-maister-local-state.mjs"],
      { cwd, env: { ...baseEnv, MAISTER_EXECUTION_HOST_STATE_DIR: foreignStateDir } },
    );

    assert.match(foreign.stdout, /skip .*execution-host state dir outside MAIster-owned roots/);
    assert.equal((await fs.stat(foreignStateDir)).isDirectory(), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("blast-maister-local-state reset accepts only DB_URL", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maister-blast-test-"));
  const env = {
    ...process.env,
    DATABASE_URL: "postgres://deprecated.example/maister",
    MAISTER_HOME: path.join(tmp, ".maister"),
    MAISTER_REPOS_ROOT: path.join(tmp, ".maister", "repos"),
  };

  delete env.DB_URL;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/blast-maister-local-state.mjs", "--reset-postgres"],
        {
          cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
          env,
        },
      ),
      /--reset-postgres requires DB_URL/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("blast-maister-local-state refuses a non-Postgres reset URL", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maister-blast-test-"));
  const env = {
    ...process.env,
    DB_URL: "file:./dev.db",
    MAISTER_HOME: path.join(tmp, ".maister"),
    MAISTER_REPOS_ROOT: path.join(tmp, ".maister", "repos"),
  };

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/blast-maister-local-state.mjs", "--reset-postgres"],
        {
          cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
          env,
        },
      ),
      /requires a postgres:\/\/ or postgresql:\/\/ DB_URL/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("blast-maister-local-state refuses a malformed reset URL", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maister-blast-test-"));
  const env = {
    ...process.env,
    DB_URL: "not a URL",
    MAISTER_HOME: path.join(tmp, ".maister"),
    MAISTER_REPOS_ROOT: path.join(tmp, ".maister", "repos"),
  };

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/blast-maister-local-state.mjs", "--reset-postgres"],
        {
          cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
          env,
        },
      ),
      /requires a valid Postgres DB_URL/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("blast-maister-local-state validates DB_URL before deleting local state", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maister-blast-test-"));
  const maisterHome = path.join(tmp, ".maister");
  const sentinel = path.join(maisterHome, "runtime", "keep.txt");
  const env = {
    ...process.env,
    DB_URL: "file:./dev.db",
    MAISTER_HOME: maisterHome,
    MAISTER_REPOS_ROOT: path.join(maisterHome, "repos"),
  };

  await fs.mkdir(path.dirname(sentinel), { recursive: true });
  await fs.writeFile(sentinel, "must remain");

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "scripts/blast-maister-local-state.mjs",
          "--reset-postgres",
          "--confirm",
          "BLAST_MAISTER_LOCAL_STATE",
        ],
        {
          cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
          env,
        },
      ),
      /requires a postgres:\/\/ or postgresql:\/\/ DB_URL/,
    );

    assert.equal(await fs.readFile(sentinel, "utf8"), "must remain");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
