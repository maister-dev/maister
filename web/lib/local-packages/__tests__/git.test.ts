import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitInitWithCommit } from "@/lib/local-packages/git";

let workingDir: string | undefined;

afterEach(async () => {
  if (workingDir) await rm(workingDir, { recursive: true, force: true });
  workingDir = undefined;
});

describe("gitInitWithCommit", () => {
  it("creates the initial local commit without executing repository hooks", async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), "local-package-git-"));
    const hookPath = path.join(workingDir, ".git", "hooks", "pre-commit");
    const sentinelPath = path.join(workingDir, "hook-ran");

    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, `#!/bin/sh\ntouch "${sentinelPath}"\n`, "utf8");
    await chmod(hookPath, 0o755);
    await writeFile(path.join(workingDir, "maister-package.yaml"), "flows: []\n", "utf8");

    await gitInitWithCommit(workingDir, "main", "maister: test initial commit");

    await expect(readFile(sentinelPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
