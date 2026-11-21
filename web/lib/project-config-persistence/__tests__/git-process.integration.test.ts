import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import {
  executeRepositoryGit,
  GitExecutionTimeout,
  withGitOwnership,
} from "../git-process";

const execute = promisify(execFile);

it.each(["graceful", "forced"] as const)(
  "waits for %s retirement before reporting an unregistered Git timeout",
  async (retirement) => {
    const root = await mkdtemp(join(tmpdir(), "git-timeout-retirement-"));
    const pidFile = join(root, "git.pid");
    const signal = retirement === "forced" ? "SIGKILL" : undefined;

    async function childIsGone(): Promise<boolean> {
      const pid = Number(await readFile(pidFile, "utf8"));

      try {
        process.kill(pid, 0);

        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;

        return true;
      }
    }

    try {
      await writeFile(
        join(root, "git"),
        `#!${process.execPath}
const { writeFileSync } = require('node:fs');
process.once('SIGTERM', () => {
  if (${retirement === "graceful"}) setTimeout(() => process.exit(1), 150);
});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => process.exit(2), 4000);
`,
        { mode: 0o755 },
      );

      try {
        const operation = executeRepositoryGit(root, ["status"], {
          timeout: 1000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
        });

        await expect(operation).rejects.toBeInstanceOf(GitExecutionTimeout);
        await expect(operation).rejects.toMatchObject({ killed: true, signal });
        expect(await childIsGone()).toBe(true);
      } finally {
        await expect.poll(childIsGone).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("IT-CPC-10: gated Git retains ownership until a short-lived hook child retires", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-git-retirement-"));
  const marker = join(root, "retired");

  try {
    await execute("git", ["-C", root, "init", "-b", "main"]);
    await execute("git", [
      "-C",
      root,
      "config",
      "user.name",
      "Retirement Test",
    ]);
    await execute("git", [
      "-C",
      root,
      "config",
      "user.email",
      "retirement@example.invalid",
    ]);
    await writeFile(join(root, "README.md"), "Owned Git retirement\n");
    await execute("git", ["-C", root, "add", "README.md"]);
    const child = `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'retired'), 100);`;

    await writeFile(
      join(root, ".git", "hooks", "post-commit"),
      `#!${process.execPath}\nrequire('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}, ${JSON.stringify(marker)}], { stdio: 'ignore' }).unref();\n`,
      { mode: 0o755 },
    );
    const output = await withGitOwnership(
      async () => {},
      () =>
        executeRepositoryGit(root, ["commit", "-m", "retire owned hook"], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }),
    );

    expect(output.stdout).toContain("retire owned hook");
    expect(await readFile(marker, "utf8")).toBe("retired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
