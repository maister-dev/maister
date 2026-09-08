import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./_fixtures/output-memory-profile.ts", import.meta.url),
);

describe("AT-01 output buffer qualification", () => {
  it("bounds twenty concurrent producers and releases every slot after drain", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "maister-output-memory-"));

    await exec(
      process.execPath,
      ["--expose-gc", "--import", "tsx", fixture, artifacts],
      { timeout: 120_000 },
    );
    const result = JSON.parse(
      await readFile(join(artifacts, "s1-2-memory.json"), "utf8"),
    ) as {
      producers: number;
      captures: number;
      peakRetainedOutputBytes: number;
      maxReservedBytes: number;
    };

    expect(result.producers).toBe(20);
    expect(result.captures).toBe(85);
    expect(result.peakRetainedOutputBytes).toBeLessThan(10 * 1024 * 1024);
    expect(result.maxReservedBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
  }, 150_000);
});
