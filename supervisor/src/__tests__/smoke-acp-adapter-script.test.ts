import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  smokeAdapter,
  summarizeCapabilityEnforcementProbe,
} from "../../scripts/smoke-acp-adapter";

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/mock-acp-compatibility.mjs", import.meta.url),
);
const hangingFixturePath = fileURLToPath(
  new URL("../../test/fixtures/mock-acp-hang-ignore-term.mjs", import.meta.url),
);

async function fixtureBinary(fixture: string = fixturePath): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maister-smoke-script-test-"));
  const binaryPath = join(dir, "opencode");

  await writeFile(
    binaryPath,
    `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`,
    "utf8",
  );
  await chmod(binaryPath, 0o755);

  return binaryPath;
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { readonly code?: unknown }).code === code
  );
}

async function killFixtureChild(pidPath: string): Promise<void> {
  let pidText: string;

  try {
    pidText = await readFile(pidPath, "utf8");
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return;
    throw err;
  }

  const pid = Number.parseInt(pidText, 10);

  if (!Number.isSafeInteger(pid)) {
    throw new Error(`fixture child pid is invalid: ${pidText}`);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if (hasErrorCode(err, "ESRCH")) return;
    throw err;
  }
}

describe("smoke ACP adapter CLI helpers", () => {
  const cleanupDirs: string[] = [];
  const cleanupPidPaths: string[] = [];
  const originalOpencodeBinary = process.env.MAISTER_ADAPTER_BINARY_OPENCODE;
  const originalSmokeChildPidPath = process.env.MAISTER_SMOKE_CHILD_PID_PATH;
  const originalSmokeChildTermPath = process.env.MAISTER_SMOKE_CHILD_TERM_PATH;

  afterEach(async () => {
    if (originalOpencodeBinary === undefined) {
      delete process.env.MAISTER_ADAPTER_BINARY_OPENCODE;
    } else {
      process.env.MAISTER_ADAPTER_BINARY_OPENCODE = originalOpencodeBinary;
    }
    if (originalSmokeChildPidPath === undefined) {
      delete process.env.MAISTER_SMOKE_CHILD_PID_PATH;
    } else {
      process.env.MAISTER_SMOKE_CHILD_PID_PATH = originalSmokeChildPidPath;
    }
    if (originalSmokeChildTermPath === undefined) {
      delete process.env.MAISTER_SMOKE_CHILD_TERM_PATH;
    } else {
      process.env.MAISTER_SMOKE_CHILD_TERM_PATH = originalSmokeChildTermPath;
    }

    await Promise.all(cleanupPidPaths.splice(0).map(killFixtureChild));

    await Promise.all(
      cleanupDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("produces ok read-only-session evidence after read, write, and unknown permission probes", async () => {
    const binaryPath = await fixtureBinary();

    cleanupDirs.push(dirname(binaryPath));
    process.env.MAISTER_ADAPTER_BINARY_OPENCODE = binaryPath;

    const result = await smokeAdapter("opencode", { readOnlySession: true });

    expect(result).toMatchObject({
      adapter: "opencode",
      status: "ok",
      readOnlySession: {
        status: "ok",
        protocolVersion: expect.any(Number),
      },
    });
  });

  it("produces ok capability-enforcement evidence after write + MCP tool-identity probes (ADR-130)", async () => {
    const binaryPath = await fixtureBinary();

    cleanupDirs.push(dirname(binaryPath));
    process.env.MAISTER_ADAPTER_BINARY_OPENCODE = binaryPath;

    const result = await smokeAdapter("opencode", {
      capabilityEnforcement: true,
    });

    expect(result).toMatchObject({
      adapter: "opencode",
      status: "ok",
      capabilityEnforcement: {
        status: "ok",
        protocolVersion: expect.any(Number),
      },
    });
  });

  it("capability-enforcement summary is 'error' when no stable identity is surfaced (ADR-130 REQ-16 negative)", () => {
    // requestPermission fired for every probe, but neither call carried a resolvable
    // tool name (a title-only adapter that never surfaces identity). The summary MUST
    // be `error` — never cache `ok` for an adapter whose calls the seam cannot govern.
    const result = summarizeCapabilityEnforcementProbe(1, [
      { kind: "edit", name: null, mcpServer: null, latencyMs: 1 },
      { kind: "other", name: null, mcpServer: null, latencyMs: 1 },
    ]);

    expect(result.status).toBe("error");
    expect(result.reason).toContain("stable tool identity");
  });

  it("reaps a SIGTERM-ignoring adapter after an initialize timeout", async () => {
    const binaryPath = await fixtureBinary(hangingFixturePath);
    const fixtureDir = dirname(binaryPath);
    const pidPath = join(fixtureDir, "child.pid");
    const termPath = join(fixtureDir, "child.term");

    cleanupDirs.push(fixtureDir);
    cleanupPidPaths.push(pidPath);
    process.env.MAISTER_ADAPTER_BINARY_OPENCODE = binaryPath;
    process.env.MAISTER_SMOKE_CHILD_PID_PATH = pidPath;
    process.env.MAISTER_SMOKE_CHILD_TERM_PATH = termPath;

    const result = await smokeAdapter("opencode");
    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);

    expect(result).toMatchObject({
      adapter: "opencode",
      status: "error",
      reason: "opencode initialize timed out",
    });
    await expect(readFile(termPath, "utf8")).resolves.toBe("received");
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);
});
