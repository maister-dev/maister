import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

import {
  acquireRepositoryFence,
  withRepositoryMutationFence,
  commonGitDirectory,
} from "../../repository-lock";
import { acquireRepositoryFenceClaim } from "../../repository-fence-claim";
import { git } from "../../git";
import { executeRepositoryGit } from "../../git-process";

import { ffUpdateLocalBranch } from "@/lib/worktree";

const [command, repo, value] = process.argv.slice(2);

if (!repo || !value) throw new Error("Missing fixture arguments");

try {
  if (command === "hold-recovery-write") {
    const rename = fs.rename;

    fs.rename = async (source, destination) => {
      if (basename(String(destination)) === "owner.json") {
        process.stdout.write("owner-write-ready\n");
        await new Promise<void>(() => {
          process.stdin.resume();
          setTimeout(() => process.exit(2), 30_000);
        });
      }

      return rename(source, destination);
    };
    syncBuiltinESMExports();
    await acquireRepositoryFence(repo, value);
  } else if (command === "hold-git" || command === "hold-bounded-git") {
    const fence = await acquireRepositoryFence(repo, value);

    const args = [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "held child",
    ];

    if (command === "hold-bounded-git") {
      await fence.run(() =>
        executeRepositoryGit(repo, args, {
          timeout: 4_000,
          maxBuffer: 1024 * 1024,
          env: process.env,
        }),
      );
    } else {
      await fence.run(() => git(repo, args));
    }
  } else if (command === "hold-ordinary") {
    await withRepositoryMutationFence(repo, async () => {
      process.stdout.write("fenced\n");
      await new Promise<void>((resolve) =>
        process.stdin.once("data", () => resolve()),
      );
    });
  } else if (command === "hold-recovery") {
    await acquireRepositoryFenceClaim(await commonGitDirectory(repo));
    process.stdout.write("recovering\n");
    process.stdin.resume();
    setTimeout(() => process.exit(2), 30_000);
  } else if (command === "hold") {
    await acquireRepositoryFence(repo, value);
    process.stdout.write("fenced\n");
    process.stdin.resume();
    setTimeout(() => process.exit(2), 30_000);
  } else {
    await ffUpdateLocalBranch(repo, "main", value);
    process.stdout.write("updated\n");
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({ code: (error as { code?: string }).code }) + "\n",
  );
  process.exitCode = 1;
}
