import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { TEST_DATABASE_DOCKER_MESSAGE } from "../pg-container";

const execFileAsync = promisify(execFile);
const childPath = fileURLToPath(
  new URL("./fixtures/docker-probe-child.ts", import.meta.url),
);

describe("shared Testcontainers database helper", () => {
  it("returns a typed, safe failure when Docker is unreachable", async () => {
    const { stdout } = await execFileAsync(
      "pnpm",
      ["exec", "tsx", "--import", "./scripts/_register-shim.mjs", childPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, DOCKER_HOST: "tcp://127.0.0.1:1" },
        timeout: 10_000,
      },
    );
    // The child writes its result line, and pino's async stdout write for the
    // same probe can land either side of it — so `.at(-1)` picked the log line
    // roughly one run in three. Take the last line that is NOT a pino record
    // (pino always carries `level`), which is order-independent.
    const result = JSON.parse(
      stdout
        .trim()
        .split("\n")
        .reverse()
        .find((line) => {
          try {
            const parsed: unknown = JSON.parse(line);

            return (
              typeof parsed === "object" &&
              parsed !== null &&
              !("level" in parsed)
            );
          } catch {
            return false;
          }
        }) ?? "{}",
    ) as {
      name?: string;
      message?: string;
    };

    expect(result.name).toBe("TestDatabaseDockerUnavailableError");
    expect(result.message).toContain(TEST_DATABASE_DOCKER_MESSAGE);
    // The child is allowed 10s above, so the test must outlast it — the unit
    // project's 5s default fired first whenever spawning `pnpm exec tsx` was
    // slow, failing on a timeout budget the test itself had already granted.
  }, 20_000);
});
