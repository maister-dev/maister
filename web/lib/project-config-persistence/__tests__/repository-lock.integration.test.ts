import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import {
  acquireRepositoryFence,
  type RepositoryFence,
} from "../repository-lock";
import { git, gitResult } from "../git";

import { sha256 } from "@/lib/evaluations/digest";

const execute = promisify(execFile);
const fixture =
  "lib/project-config-persistence/__tests__/fixtures/repository-mutator.ts";
const loaderArgs = [
  "--import",
  "./scripts/_register-shim.mjs",
  "--import",
  "tsx",
  fixture,
];

it("IT-CPC-04: fenced Git reads preserve UTF-8 across subprocess chunk boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-git-utf8-"));

  try {
    await execute("git", ["init", "-b", "main", root]);
    const content = "€𝄞".repeat(80_000);

    await writeFile(join(root, "unicode.txt"), content);
    await git(root, ["add", "unicode.txt"]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "unicode source",
    ]);
    const fence = await acquireRepositoryFence(root, randomUUID());

    try {
      expect(
        sha256(await fence.run(() => git(root, ["show", "HEAD:unicode.txt"]))),
      ).toBe(sha256(content));
    } finally {
      await fence.release();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("IT-CPC-10: releasing a fence preserves unexpected operator files and requires explicit resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-unknown-fence-"));

  try {
    await execute("git", ["init", "-b", "main", root]);
    const fence = await acquireRepositoryFence(root, randomUUID());
    const note = join(
      root,
      ".git",
      "maister-config-mutation.lock",
      "operator-note",
    );

    await writeFile(note, "do not discard");
    await expect(fence.release()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(note, "utf8")).toBe("do not discard");
    await rm(note);
    await fence.release();
    await mkdir(join(root, ".git", "maister-config-mutation.lock"));
    await expect(
      acquireRepositoryFence(root, randomUUID()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["complete", "timeout"] as const)(
  "IT-CPC-10: owner death retains the Git fence until child %s",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "config-child-owner-"));
    const socketPath = join(root, "gate.sock");
    const server = createServer();
    const listening = once(server, "listening");

    server.listen(socketPath);
    await listening;
    try {
      await execute("git", ["init", "-b", "main", root]);
      await git(root, [
        "config",
        "core.hooksPath",
        join(root, ".git", "hooks"),
      ]);
      const hook = `#!${process.execPath}\nconst s=require('node:net').createConnection(${JSON.stringify(socketPath)},()=>s.write('ready'));s.on('end',()=>process.exit(0));\n`;

      await writeFile(join(root, ".git", "hooks", "pre-commit"), hook, {
        mode: 0o700,
      });
      const operationId = randomUUID();
      const connected = once(server, "connection");
      const child = spawn(
        process.execPath,
        [
          ...loaderArgs,
          outcome === "timeout" ? "hold-bounded-git" : "hold-git",
          root,
          operationId,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const [socket] = await connected;

      try {
        await once(socket, "data");
        const exited = once(child, "exit");
        const closed = once(child, "close");

        child.kill("SIGKILL");
        await exited;
        await expect(
          acquireRepositoryFence(root, operationId),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        if (outcome === "complete") socket.end();
        else
          await expect
            .poll(() => socket.destroyed, { timeout: 10_000 })
            .toBe(true);
        await closed;
        let recovered: RepositoryFence | undefined;

        await expect
          .poll(async () => {
            try {
              recovered = await acquireRepositoryFence(root, operationId);

              return true;
            } catch (error) {
              if ((error as { code?: string }).code !== "CONFLICT") throw error;

              return false;
            }
          })
          .toBe(true);

        await recovered!.release();
        if (outcome === "complete")
          expect((await git(root, ["log", "-1", "--format=%s"])).trim()).toBe(
            "held child",
          );
        else
          expect(
            (
              await gitResult(root, [
                "rev-parse",
                "--verify",
                "--quiet",
                "HEAD",
              ])
            ).code,
          ).toBe(1);
      } finally {
        try {
          const recorded = JSON.parse(
            await readFile(
              join(root, ".git", "maister-config-mutation.lock", "owner.json"),
              "utf8",
            ),
          ) as { groups: number[] };

          for (const group of recorded.groups) {
            try {
              process.kill(-group, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                throw error;
            }
          }
          await expect
            .poll(async () => {
              try {
                const lease = await acquireRepositoryFence(root, operationId);

                await lease.release();

                return true;
              } catch (error) {
                if ((error as { code?: string }).code === "CONFLICT")
                  return false;
                throw error;
              }
            })
            .toBe(true);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        socket.destroy();
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("IT-CPC-10: two processes share the common-directory fence, unrelated repositories progress, and dead owners require exact-operation recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-cross-process-"));
  const repo = join(root, "repo");
  const other = join(root, "other");

  try {
    for (const path of [repo, other]) {
      await execute("git", ["init", "-b", "main", path]);
      await git(path, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      ]);
    }
    const base = (await git(repo, ["rev-parse", "HEAD"])).trim();

    await git(repo, ["checkout", "-b", "next"]);
    await writeFile(join(repo, "next.txt"), "next");
    await git(repo, ["add", "next.txt"]);
    await git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "next",
    ]);
    const next = (await git(repo, ["rev-parse", "HEAD"])).trim();

    await git(repo, ["checkout", "main"]);
    const operationId = randomUUID();
    const alias = join(root, "repository-alias");

    await symlink(repo, alias);
    const child = spawn(
      process.execPath,
      [...loaderArgs, "hold", repo, operationId],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    try {
      const [chunk] = await once(child.stdout, "data");

      expect(String(chunk)).toContain("fenced");
      await expect(
        execute(process.execPath, [...loaderArgs, "ff", alias, next]),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining('"code":"CONFLICT"'),
      });
      expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(base);
      const unrelated = await acquireRepositoryFence(other, randomUUID());

      await unrelated.release();
      const exited = once(child, "exit");

      child.kill("SIGKILL");
      await exited;
      await expect(
        execute(process.execPath, [...loaderArgs, "ff", repo, next]),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining('"code":"CONFLICT"'),
      });
      await expect(
        acquireRepositoryFence(repo, randomUUID()),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const recovered = await acquireRepositoryFence(repo, operationId);

      await recovered.release();
      await execute(process.execPath, [...loaderArgs, "ff", repo, next]);
      expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(next);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");

        child.kill("SIGKILL");
        await exited;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
