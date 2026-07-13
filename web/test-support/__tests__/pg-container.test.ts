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
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
      name?: string;
      message?: string;
    };

    expect(result.name).toBe("TestDatabaseDockerUnavailableError");
    expect(result.message).toContain(TEST_DATABASE_DOCKER_MESSAGE);
  });
});
