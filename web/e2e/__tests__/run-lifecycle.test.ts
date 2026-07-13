import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { terminatePlaywrightChild } from "../run";

const resistantChildPath = fileURLToPath(
  new URL("./fixtures/sigterm-resistant-child.mjs", import.meta.url),
);

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;

    throw error;
  }
}

describe("E2E Playwright child lifecycle", () => {
  it("escalates a SIGTERM-resistant process group and observes every child exit", async () => {
    const child = spawn(process.execPath, [resistantChildPath], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "inherit"],
    });

    try {
      const [output] = await once(child.stdout!, "data");
      const nestedChildPid = Number.parseInt(
        output.toString().replace("ready:", ""),
        10,
      );

      expect(nestedChildPid).toBeGreaterThan(0);

      await terminatePlaywrightChild(child, "SIGTERM", 50);

      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe("SIGKILL");
      await vi.waitFor(() => expect(processExists(nestedChildPid)).toBe(false));
    } finally {
      if (!childHasExited(child)) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });
});
