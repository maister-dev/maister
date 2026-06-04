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
