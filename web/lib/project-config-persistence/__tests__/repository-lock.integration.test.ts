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
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import {
  acquireRepositoryFence,
  type RepositoryFence,
} from "../repository-lock";
import { git, gitResult } from "../git";
import { acquireRepositoryFenceClaim } from "../repository-fence-claim";

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

it("IT-CPC-10: interrupted owner replacement preserves an adoptable prior fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-owner-replacement-"));
  const id = randomUUID();

  try {
    await execute("git", ["init", "-b", "main", root]);
    for (const [command, checkpoint] of [
      ["hold", "fenced"],
      ["hold-recovery-write", "owner-write-ready"],
    ]) {
      const child = spawn(
        process.execPath,
        [...loaderArgs, command!, root, id],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      try {
        expect(String((await once(child.stdout, "data"))[0])).toContain(
          checkpoint,
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");

          child.kill("SIGKILL");
          await exited;
        }
      }
    }
    const recovered = await acquireRepositoryFence(root, id);

    await recovered.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("IT-CPC-10: an ordinary repository mutation can retry after its owner dies", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-ordinary-retry-"));

  try {
    await execute("git", ["init", "-b", "main", root]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    const child = spawn(
      process.execPath,
      [...loaderArgs, "hold-ordinary", root, head],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    try {
      expect(String((await once(child.stdout, "data"))[0])).toContain("fenced");
      await expect(
        execute(process.execPath, [...loaderArgs, "ff", root, head]),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining('"code":"CONFLICT"'),
      });
      const exited = once(child, "exit");

      child.kill("SIGKILL");
      await exited;
      // Retry the production entry point without reading or supplying the old owner ID.
      await expect(
        execute(process.execPath, [...loaderArgs, "ff", root, head]),
      ).resolves.toMatchObject({
        stdout: expect.stringContaining("updated"),
      });
      expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(head);
      await expect(
        readFile(
          join(root, ".git", "maister-config-mutation.lock", "owner.json"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
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

it("IT-CPC-10: death during recovery releases adoption exclusion and competing retries have one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-recovery-retry-"));
  const id = randomUUID();

  try {
    await execute("git", ["init", "-b", "main", root]);
    const prior = await acquireRepositoryFence(root, id);

    prior.retain();
    const child = spawn(
      process.execPath,
      [...loaderArgs, "hold-recovery", root, id],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    try {
      expect(String((await once(child.stdout, "data"))[0])).toContain(
        "recovering",
      );
      await expect(acquireRepositoryFence(root, id)).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "operation_busy" },
      });
      const exited = once(child, "exit");

      child.kill("SIGKILL");
      await exited;
      const contenders = await Promise.allSettled([
        acquireRepositoryFence(root, id),
        acquireRepositoryFence(root, id),
      ]);
      const winners = contenders.filter(
        (result) => result.status === "fulfilled",
      );

      try {
        expect(winners).toHaveLength(1);
        expect(
          contenders.filter((result) => result.status === "rejected"),
        ).toEqual([
          expect.objectContaining({
            reason: expect.objectContaining({ code: "CONFLICT" }),
          }),
        ]);
      } finally {
        for (const winner of winners) await winner.value.release();
      }
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
    // Unknown legacy claims and nonempty mutex paths are operator evidence,
    // including unrelated SQLite files that must never be opened/recovered.
    for (const name of [
      "maister-config-mutation.recovery.lock",
      "maister-config-mutation.mutex.sqlite",
    ]) {
      const path = join(root, ".git", name);

      await writeFile(path, "operator evidence");
      await expect(
        acquireRepositoryFenceClaim(join(root, ".git")),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await readFile(path, "utf8")).toBe("operator evidence");
      // The fixture operator resolves its own collision, not the product.
      await rm(path);
    }
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

it("IT-CPC-04: module reload cannot adopt a live same-process ownership fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-fence-reload-"));
  const operationId = randomUUID();
  let first: RepositoryFence | undefined;
  let unexpected: RepositoryFence | undefined;

  try {
    await execute("git", ["init", "-b", "main", root]);
    first = await acquireRepositoryFence(root, operationId);
    const before = await readFile(
      join(root, ".git", "maister-config-mutation.lock", "owner.json"),
      "utf8",
    );

    vi.resetModules();
    const reloaded = await import("../repository-lock");
    const attempt = reloaded
      .acquireRepositoryFence(root, operationId)
      .then((lease) => {
        unexpected = lease;

        return lease;
      });

    await expect(attempt).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "operation_busy" },
    });
    expect(
      await readFile(
        join(root, ".git", "maister-config-mutation.lock", "owner.json"),
        "utf8",
      ),
    ).toBe(before);
  } finally {
    if (unexpected) {
      await unexpected.release();
      first?.retain();
    } else await first?.release();
    await rm(root, { recursive: true, force: true });
  }
});

it("IT-CPC-10: an owned hook child cannot outlive Git unnoticed", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-bg-"));
  const socketPath = join(root, "gate.sock");
  const server = createServer();
  const operationId = randomUUID();
  let fence: RepositoryFence | undefined;
  let socket: Socket | undefined;

  try {
    const listening = once(server, "listening");

    server.listen(socketPath);
    await listening;
    await execute("git", ["init", "-b", "main", root]);
    await git(root, ["config", "core.hooksPath", join(root, ".git", "hooks")]);
    const background = `const s=require('node:net').createConnection(${JSON.stringify(socketPath)},()=>{s.write('ready');process.send('ready');});s.on('end',()=>process.exit(0));setTimeout(()=>process.exit(1),10000);`;
    const hook = `#!${process.execPath}\nconst c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(background)}],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{c.disconnect();c.unref();process.exit(0);});c.once('error',()=>process.exit(1));setTimeout(()=>process.exit(1),10000);\n`;

    await writeFile(join(root, ".git", "hooks", "post-commit"), hook, {
      mode: 0o700,
    });
    fence = await acquireRepositoryFence(root, operationId);
    const connected = once(server, "connection");
    const outcome = fence
      .run(() =>
        git(root, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "owned background",
        ]),
      )
      .then(
        () => ({ ok: true, error: null }),
        (error: unknown) => ({ ok: false, error }),
      );

    socket = (await connected)[0] as Socket;
    await once(socket, "data");
    const result = await outcome;

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "recovery_required" },
    });
    expect((await git(root, ["log", "-1", "--format=%s"])).trim()).toBe(
      "owned background",
    );
  } finally {
    if (socket && !socket.destroyed) {
      const closed = once(socket, "close");

      socket.end();
      await closed;
    }
    if (fence)
      await expect
        .poll(
          async () => {
            try {
              await fence!.release();

              return true;
            } catch (error) {
              if ((error as { code?: string }).code === "CONFLICT")
                return false;
              throw error;
            }
          },
          { timeout: 10000 },
        )
        .toBe(true);
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(root, { recursive: true, force: true });
  }
});

it("IT-CPC-10: index reservation retirement removes only the exact owned hard link", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-index-reservation-"));
  const id = randomUUID();
  let fence: RepositoryFence | undefined;

  try {
    await execute("git", ["init", "-b", "main", root]);
    fence = await acquireRepositoryFence(root, id);
    await fence.run(() => fence!.reserveIndex());
    await writeFile(join(root, "operator.txt"), "preserve operator work\n");
    expect(
      (await fence.run(() => gitResult(root, ["add", "operator.txt"]))).code,
    ).not.toBe(0);
    fence.retain();
    fence = await acquireRepositoryFence(root, id);
    await expect(
      readFile(join(root, ".git", "index.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await fence.release();
    fence = undefined;
    await git(root, ["add", "operator.txt"]);
    expect(await readFile(join(root, "operator.txt"), "utf8")).toBe(
      "preserve operator work\n",
    );
  } finally {
    fence?.retain();
    await rm(root, { recursive: true, force: true });
  }
});

it("IT-CPC-08/10: a foreign index lock collision is retained and never removed on release", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-index-collision-"));
  let fence: RepositoryFence | undefined;

  try {
    await execute("git", ["init", "-b", "main", root]);
    fence = await acquireRepositoryFence(root, randomUUID());
    await writeFile(join(root, ".git", "index.lock"), "foreign Git lock\n");
    await expect(fence.run(() => fence!.reserveIndex())).rejects.toMatchObject({
      details: { reason: "recovery_required" },
    });
    await fence.release();
    fence = undefined;
    expect(await readFile(join(root, ".git", "index.lock"), "utf8")).toBe(
      "foreign Git lock\n",
    );
  } finally {
    fence?.retain();
    await rm(root, { recursive: true, force: true });
  }
});

it("IT-CPC-10: a replacement index lock is preserved until explicit operator resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-index-replacement-"));
  const id = randomUUID();
  let fence: RepositoryFence | undefined;

  try {
    await execute("git", ["init", "-b", "main", root]);
    fence = await acquireRepositoryFence(root, id);
    await fence.run(() => fence!.reserveIndex());
    await rm(join(root, ".git", "index.lock"));
    await writeFile(join(root, ".git", "index.lock"), "replacement owner\n");
    fence.retain();
    fence = undefined;
    await expect(acquireRepositoryFence(root, id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await readFile(join(root, ".git", "index.lock"), "utf8")).toBe(
      "replacement owner\n",
    );
    // The fixture simulates the operator resolving their own replacement lock.
    await rm(join(root, ".git", "index.lock"));
    fence = await acquireRepositoryFence(root, id);
    await fence.release();
    fence = undefined;
  } finally {
    fence?.retain();
    await rm(root, { recursive: true, force: true });
  }
});
