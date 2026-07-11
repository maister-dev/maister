import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { smokeAdapter } from "../../scripts/smoke-acp-adapter";

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/mock-acp-compatibility.mjs", import.meta.url),
);

async function fixtureBinary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maister-smoke-script-test-"));
  const binaryPath = join(dir, "opencode");

  await writeFile(
    binaryPath,
    `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fixturePath).href)};\n`,
    "utf8",
  );
  await chmod(binaryPath, 0o755);

  return binaryPath;
}

describe("smoke ACP adapter CLI helpers", () => {
  const cleanupDirs: string[] = [];
  const originalOpencodeBinary = process.env.MAISTER_ADAPTER_BINARY_OPENCODE;

  afterEach(async () => {
    if (originalOpencodeBinary === undefined) {
      delete process.env.MAISTER_ADAPTER_BINARY_OPENCODE;
    } else {
      process.env.MAISTER_ADAPTER_BINARY_OPENCODE = originalOpencodeBinary;
    }

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

  it("produces ok capability-enforcement evidence after write + MCP tool-identity probes (ADR-129)", async () => {
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
});
