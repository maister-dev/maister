import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  releaseMaterializationLock,
  tryAcquireMaterializationLock,
  type MaterializationLockHandle,
} from "@/lib/agents/materialization-lock";

let root: string;
const handles: MaterializationLockHandle[] = [];
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../..");
const holderFixture = path.join(
  here,
  "fixtures",
  "hold-materialization-lock.ts",
);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "materialization-lock-"));
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map(releaseMaterializationLock));
  await rm(root, { recursive: true, force: true });
});

async function acquire(): Promise<MaterializationLockHandle> {
  const handle = await tryAcquireMaterializationLock(root);

  expect(handle).not.toBeNull();
  if (!handle) throw new Error("expected materialization lock");
  handles.push(handle);

  return handle;
}

async function waitForHolder(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      reject(new Error(`lock holder did not start: ${output}`));
    }, 5_000);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("acquired\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `lock holder exited before acquiring (code=${code}, signal=${signal}): ${output}${errorOutput}`,
        ),
      );
    });
  });
}

describe("agent materialization lock", () => {
  it("serializes writers until the current owner releases the SQLite mutex", async () => {
    const first = await acquire();

    await expect(tryAcquireMaterializationLock(root)).resolves.toBeNull();

    await releaseMaterializationLock(first);
    const second = await acquire();

    expect(second).not.toBe(first);
  });

  it("does not let a late release unlock a newer owner", async () => {
    const first = await acquire();

    await releaseMaterializationLock(first);
    const second = await acquire();

    await releaseMaterializationLock(first);
    await expect(tryAcquireMaterializationLock(root)).resolves.toBeNull();

    await releaseMaterializationLock(second);
  });

  it("recovers the mutex after a holder process is killed", async () => {
    const child = spawn(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", holderFixture, root],
      {
        cwd: webRoot,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    try {
      await waitForHolder(child);
      await expect(tryAcquireMaterializationLock(root)).resolves.toBeNull();

      child.kill("SIGKILL");
      await once(child, "exit");

      await acquire();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  }, 10_000);

  it("ignores legacy lock artifacts because the mutex is crash-recoverable", async () => {
    await mkdir(path.join(root, "lock"));

    await acquire();
  });

  it("refuses a symlinked SQLite mutex without touching its target", async () => {
    const outside = path.join(root, "outside.sqlite");

    await writeFile(outside, "outside-data");
    await symlink(outside, path.join(root, "mutex.sqlite"));

    await expect(tryAcquireMaterializationLock(root)).rejects.toThrow(
      /mutex is symlinked/,
    );
    await expect(readFile(outside, "utf8")).resolves.toBe("outside-data");
  });
});
