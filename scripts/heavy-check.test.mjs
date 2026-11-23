import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("./heavy-check.sh", import.meta.url));

// Keeping stdin open models the whole lifetime of a validation invocation.
const check = 'process.stdin.resume(); process.stdout.write("started");';

for (const limit of [1, 2]) {
  test(
    `shares ${limit} slots across worktrees and releases on death`,
    { timeout: 15000 },
    async (t) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "maister-check-test-"),
      );
      const env = {
        ...process.env,
        MAISTER_MAX_CONCURRENT_HEAVY_CHECKS: String(limit),
        MAISTER_HEAVY_CHECK_DIR: path.join(directory, "slots"),
      };
      const children = [];
      t.after(async () => {
        for (const { child } of children) child.kill("SIGKILL");
        await Promise.all(children.map(({ exited }) => exited));
        await rm(directory, { recursive: true, force: true });
      });

      async function start(index) {
        const cwd = path.join(directory, String(index));
        await mkdir(cwd);
        const child = spawn("sh", [launcher, process.execPath, "-e", check], {
          cwd,
          env,
        });
        const handle = {
          child,
          started: once(child.stdout, "data"),
          waiting: once(child.stderr, "data"),
          exited: once(child, "exit"),
        };
        children.push(handle);
        return handle;
      }

      for (let index = 0; index < limit; index++) {
        const active = await start(index);
        assert.equal(String((await active.started)[0]), "started");
      }
      const queued = await start(limit);
      assert.deepEqual(JSON.parse(String((await queued.waiting)[0])), {
        event: "heavy_check_waiting",
        limit,
        directory: env.MAISTER_HEAVY_CHECK_DIR,
      });
      // Free the last slot, while any earlier slot remains occupied.
      children[limit - 1].child.kill("SIGKILL");
      assert.equal(String((await queued.started)[0]), "started");
      queued.child.stdin.end();
      assert.deepEqual(await queued.exited, [0, null]);
    },
  );
}

test("unset bypasses coordination, invalid budgets refuse to execute", () => {
  const env = {
    ...process.env,
    MAISTER_HEAVY_CHECK_DIR: "deliberately-relative",
  };
  delete env.MAISTER_MAX_CONCURRENT_HEAVY_CHECKS;
  const args = [
    launcher,
    process.execPath,
    "-e",
    "process.exit(process.argv[1] === 'two words' ? 17 : 18)",
    "two words",
  ];
  assert.equal(spawnSync("sh", args, { env }).status, 17);
  for (const invalid of ["", "0", "1.5"]) {
    const result = spawnSync("sh", args, {
      env: { ...env, MAISTER_MAX_CONCURRENT_HEAVY_CHECKS: invalid },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be a positive integer/);
  }
});
