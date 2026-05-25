import { mkdtemp, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWriteJson } from "@/lib/atomic";

describe("atomicWriteJson", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "atomic-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("creates missing parent directories", async () => {
    const target = join(workDir, "a", "b", "c", "file.json");

    await atomicWriteJson(target, { hello: "world" });

    const raw = await readFile(target, "utf8");

    expect(JSON.parse(raw)).toEqual({ hello: "world" });
  });

  it("100x parallel writes leave a valid JSON file (no torn writes)", async () => {
    const target = join(workDir, "race.json");
    const writes = Array.from({ length: 100 }, (_, i) =>
      atomicWriteJson(target, { i, payload: "x".repeat(1024) }),
    );

    await Promise.all(writes);

    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as { i: number; payload: string };

    expect(parsed.payload).toBe("x".repeat(1024));
    expect(parsed.i).toBeGreaterThanOrEqual(0);
    expect(parsed.i).toBeLessThan(100);
  });

  it("does not leave .tmp files after parallel writes", async () => {
    const target = join(workDir, "cleanup.json");
    const writes = Array.from({ length: 50 }, (_, i) =>
      atomicWriteJson(target, { i }),
    );

    await Promise.all(writes);

    const entries = await readdir(workDir);
    const tmps = entries.filter((e) => e.endsWith(".tmp"));

    expect(tmps).toEqual([]);
  });

  it("cleans up the .tmp file when the write fails (circular JSON)", async () => {
    const target = join(workDir, "fail.json");
    const circular: Record<string, unknown> = {};

    circular.self = circular;

    await expect(atomicWriteJson(target, circular)).rejects.toThrow();

    const entries = await readdir(workDir);
    const tmps = entries.filter((e) => e.endsWith(".tmp"));

    expect(tmps).toEqual([]);
  });

  it("final file has 0o644 permissions (Node fs default)", async () => {
    const target = join(workDir, "perm.json");

    await atomicWriteJson(target, { ok: true });

    const st = await stat(target);
    const mode = st.mode & 0o777;

    expect(mode).toBe(0o644);
  });
});
