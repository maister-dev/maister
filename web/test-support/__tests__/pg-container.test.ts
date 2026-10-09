import type { Socket } from "node:net";

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { TEST_DATABASE_DOCKER_MESSAGE } from "../pg-container";

const execFileAsync = promisify(execFile);
const childPath = fileURLToPath(
  new URL("./fixtures/docker-probe-child.ts", import.meta.url),
);

type DockerProbeOutcome = Readonly<{
  name?: string;
  message?: string;
  durationMs?: number;
}>;

async function runDockerProbe(endpoint: string): Promise<DockerProbeOutcome> {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["exec", "tsx", "--import", "./scripts/_register-shim.mjs", childPath],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DOCKER_HOST: endpoint,
        MAISTER_TEST_DOCKER_PROBE_TIMEOUT_MS: "3000",
      },
      timeout: 10_000,
    },
  );

  // The child writes its result line, and pino's async stdout write for the
  // same probe can land either side of it — so `.at(-1)` picked the log line
  // roughly one run in three. Take the last line that is NOT a pino record
  // (pino always carries `level`), which is order-independent.
  return JSON.parse(
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
    durationMs?: number;
  };
}

describe("shared Testcontainers database helper", () => {
  it("returns a typed, safe failure when Docker is unreachable", async () => {
    const result = await runDockerProbe("tcp://127.0.0.1:1");

    expect(result.name).toBe("TestDatabaseDockerUnavailableError");
    expect(result.message).toContain(TEST_DATABASE_DOCKER_MESSAGE);
    expect(result.durationMs).toBeLessThan(3_500);
  }, 20_000);

  it("bounds and aborts a stalled daemon request without discovering another target", async () => {
    const sockets = new Set<Socket>();
    const paths: string[] = [];
    const server = createServer((request) => {
      paths.push(request.url ?? "/");
    });

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("daemon deadline control has no address");
    try {
      const result = await runDockerProbe(`tcp://127.0.0.1:${address.port}`);

      expect(result.name).toBe("TestDatabaseDockerUnavailableError");
      expect(result.message).toContain("daemon probe timed out");
      expect(result.durationMs).toBeGreaterThanOrEqual(3_000);
      expect(result.durationMs).toBeLessThan(3_500);
      expect(paths).toEqual(["/info"]);
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 20_000);
});
