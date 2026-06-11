import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listInstalledPackageFiles,
  readInstalledPackageFile,
} from "@/lib/flows/package-content";

async function seedBundle(root: string): Promise<void> {
  await writeFile(join(root, "flow.yaml"), "schemaVersion: 1\nname: Demo\n");
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await writeFile(
    join(root, "skills", "demo", "SKILL.md"),
    "---\nname: demo\n---\nbody\n",
  );
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(join(root, "rules", "guard.md"), "guardrail\n");
  await mkdir(join(root, "schemas"), { recursive: true });
  await writeFile(join(root, "schemas", "review.json"), '{"a":1}\n');
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
  await writeFile(join(root, "README.md"), "# readme\n");
}

describe("listInstalledPackageFiles", () => {
  let bundleRoot: string;

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), "pkg-content-list-"));
  });

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true });
  });

  it("walks the bundle, classifies by path, excludes flow.yaml, returns flowYaml separately", async () => {
    await seedBundle(bundleRoot);

    const result = await listInstalledPackageFiles({
      installedPath: bundleRoot,
    });

    expect(result.bundleMissing).toBe(false);

    if (result.bundleMissing) throw new Error("unexpected bundleMissing");

    expect(result.flowYaml).toBe("schemaVersion: 1\nname: Demo\n");

    const byPath = new Map(result.files.map((f) => [f.path, f]));

    expect(byPath.has("flow.yaml")).toBe(false);

    expect(byPath.get("skills/demo/SKILL.md")?.kind).toBe("skill");
    expect(byPath.get("rules/guard.md")?.kind).toBe("rule");
    expect(byPath.get("schemas/review.json")?.kind).toBe("schema");
    expect(byPath.get("scripts/run.sh")?.kind).toBe("script");
    expect(byPath.get("README.md")?.kind).toBe("readme");

    for (const f of result.files) {
      expect(typeof f.size).toBe("number");
      expect(f.size).toBeGreaterThan(0);
      // §8.1.6: entries are bundle-relative — an absolute path / installedPath
      // must NEVER leak into a result that crosses to the client.
      expect(f.path.startsWith("/")).toBe(false);
    }

    // exact byte length, not just truthiness ("# readme\n" = 9 bytes).
    expect(byPath.get("README.md")?.size).toBe(9);
    // the absolute server root must not appear anywhere in the serialized result.
    expect(JSON.stringify(result)).not.toContain(bundleRoot);
  });

  it("returns flowYaml=null when the root flow.yaml is absent", async () => {
    await writeFile(join(bundleRoot, "README.md"), "# only readme\n");

    const result = await listInstalledPackageFiles({
      installedPath: bundleRoot,
    });

    if (result.bundleMissing) throw new Error("unexpected bundleMissing");

    expect(result.flowYaml).toBeNull();
    expect(result.files.map((f) => f.path)).toEqual(["README.md"]);
  });

  it("omits an oversized flow.yaml (size cap) instead of reading it unbounded", async () => {
    await writeFile(join(bundleRoot, "flow.yaml"), "a".repeat(1024 * 1024 + 1));
    await writeFile(join(bundleRoot, "README.md"), "# readme\n");

    const result = await listInstalledPackageFiles({
      installedPath: bundleRoot,
    });

    if (result.bundleMissing) throw new Error("unexpected bundleMissing");

    // over the 1 MiB cap → not read into memory; flowYaml stays null.
    expect(result.flowYaml).toBeNull();
    expect(result.files.map((f) => f.path)).toContain("README.md");
  });

  it("skips non-regular files (symlinks) during the walk", async () => {
    await seedBundle(bundleRoot);
    const secret = await mkdtemp(join(tmpdir(), "pkg-content-secret-"));

    try {
      await writeFile(join(secret, "outside.txt"), "SECRET");
      await symlink(
        join(secret, "outside.txt"),
        join(bundleRoot, "link-to-secret.txt"),
      );

      const result = await listInstalledPackageFiles({
        installedPath: bundleRoot,
      });

      if (result.bundleMissing) throw new Error("unexpected bundleMissing");

      expect(result.files.some((f) => f.path === "link-to-secret.txt")).toBe(
        false,
      );
    } finally {
      await rm(secret, { recursive: true, force: true });
    }
  });

  it("returns { bundleMissing: true } for a non-existent dir", async () => {
    const result = await listInstalledPackageFiles({
      installedPath: join(bundleRoot, "does-not-exist"),
    });

    expect(result).toEqual({ bundleMissing: true });
  });
});

describe("readInstalledPackageFile", () => {
  let bundleRoot: string;

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), "pkg-content-read-"));
  });

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true });
  });

  it("reads a text file with its inferred kind", async () => {
    await mkdir(join(bundleRoot, "schemas"), { recursive: true });
    await writeFile(join(bundleRoot, "schemas", "review.json"), '{"a":1}\n');

    const result = await readInstalledPackageFile(
      { installedPath: bundleRoot },
      "schemas/review.json",
    );

    expect(result).toEqual({
      state: "text",
      content: '{"a":1}\n',
      kind: "schema",
    });
  });

  it.each([
    ["traversal", "../etc/passwd"],
    ["absolute", "/etc/passwd"],
    ["NUL byte", "a\x00b"],
    ["leading dash", "-rf"],
  ])(
    "rejects %s rel paths as not-found before any fs read",
    async (_label, relPath) => {
      const result = await readInstalledPackageFile(
        { installedPath: bundleRoot },
        relPath,
      );

      expect(result).toEqual({ state: "not-found" });
    },
  );

  it("rejects an invalid rel path BEFORE any fs read (not-found, not bundle-missing)", async () => {
    // The bundle dir does not exist: a valid-but-absent path would surface
    // bundle-missing (realpath of the root throws ENOENT). A rejected `..` path
    // must short-circuit to not-found FIRST — proving zod validation precedes
    // any realpath/stat of the root.
    const result = await readInstalledPackageFile(
      { installedPath: join(bundleRoot, "gone") },
      "../escape",
    );

    expect(result).toEqual({ state: "not-found" });
  });

  it("rejects a symlink that escapes the bundle (realpath check), never leaking the secret", async () => {
    const secret = await mkdtemp(join(tmpdir(), "pkg-content-escape-"));

    try {
      await writeFile(join(secret, "secret.txt"), "TOP-SECRET");
      await symlink(join(secret, "secret.txt"), join(bundleRoot, "escape.txt"));

      const result = await readInstalledPackageFile(
        { installedPath: bundleRoot },
        "escape.txt",
      );

      expect(result).toEqual({ state: "not-found" });
      expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
    } finally {
      await rm(secret, { recursive: true, force: true });
    }
  });

  it("returns too-large for a file over 1 MiB", async () => {
    await writeFile(join(bundleRoot, "big.txt"), "a".repeat(1024 * 1024 + 1));

    const result = await readInstalledPackageFile(
      { installedPath: bundleRoot },
      "big.txt",
    );

    expect(result).toEqual({ state: "too-large" });
  });

  it("returns binary for a file containing a NUL byte", async () => {
    await writeFile(
      join(bundleRoot, "bin.dat"),
      Uint8Array.from([0x68, 0x00, 0x69]),
    );

    const result = await readInstalledPackageFile(
      { installedPath: bundleRoot },
      "bin.dat",
    );

    expect(result).toEqual({ state: "binary" });
  });

  it("returns not-found when the rel path names an existing DIRECTORY (no EISDIR throw)", async () => {
    await mkdir(join(bundleRoot, "skills", "demo"), { recursive: true });

    const result = await readInstalledPackageFile(
      { installedPath: bundleRoot },
      "skills",
    );

    expect(result).toEqual({ state: "not-found" });
  });

  it("returns not-found for a valid-but-absent rel path", async () => {
    const result = await readInstalledPackageFile(
      { installedPath: bundleRoot },
      "skills/missing/SKILL.md",
    );

    expect(result).toEqual({ state: "not-found" });
  });

  it("returns bundle-missing when the bundle dir is gone", async () => {
    const result = await readInstalledPackageFile(
      { installedPath: join(bundleRoot, "gone") },
      "README.md",
    );

    expect(result).toEqual({ state: "bundle-missing" });
  });
});
