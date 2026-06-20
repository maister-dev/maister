import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveWithinWorkingDir } from "../paths";

// (ADR-096, D5) The path-confinement guard is the security boundary for every
// working-dir file op — UNTRUSTED, url/body-controlled `relPath`.
describe("resolveWithinWorkingDir", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lp-confine-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "lp-outside-"));
    await mkdir(path.join(root, "flows"), { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("resolves a nested path within the working dir", async () => {
    const r = await resolveWithinWorkingDir(root, "flows/foo.yaml");
    // The guard returns the realpath-canonicalized path (on macOS /var is a
    // symlink to /private/var) — compare against the realpath'd root.
    const realRoot = await realpath(root);

    expect(r).toBe(path.join(realRoot, "flows", "foo.yaml"));
  });

  it("rejects parent traversal", async () => {
    await expect(
      resolveWithinWorkingDir(root, "../escape"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("rejects absolute paths", async () => {
    await expect(
      resolveWithinWorkingDir(root, "/etc/passwd"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("rejects .git paths", async () => {
    await expect(
      resolveWithinWorkingDir(root, ".git/config"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("rejects leading-dash and NUL", async () => {
    await expect(resolveWithinWorkingDir(root, "-rf")).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    await expect(resolveWithinWorkingDir(root, "a\0b")).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("rejects a symlink that escapes the working dir", async () => {
    await symlink(outside, path.join(root, "link"));
    await expect(
      resolveWithinWorkingDir(root, "link/secret"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("rejects a symlink LEAF that points to a file outside the working dir", async () => {
    // The leaf itself is the symlink: the ancestor walk passes (its parent is a
    // real dir), so only the final realpath-of-leaf check catches the escape.
    // This is the readFileContent / fsReadFile-follows-symlink vector.
    const outsideFile = path.join(outside, "secret.txt");

    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, path.join(root, "leaf-escape"));
    await expect(
      resolveWithinWorkingDir(root, "leaf-escape"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("allows a symlink leaf whose real target stays within the working dir", async () => {
    const target = path.join(root, "real.txt");

    await writeFile(target, "ok");
    await symlink(target, path.join(root, "inside-link"));
    await expect(
      resolveWithinWorkingDir(root, "inside-link"),
    ).resolves.toContain("inside-link");
  });

  it("rejects a symlinked ancestor even when the leaf parent does not exist yet", async () => {
    // The escape the previous case misses: `escdeep` exists (→ outside) but the
    // intermediate dir does NOT. The old guard realpath'd only the immediate
    // parent and lexically accepted the missing one, so `mkdir -p` would create
    // `newdir` UNDER the symlink target. The fix realpaths the nearest EXISTING
    // ancestor (`escdeep`) and rejects.
    await symlink(outside, path.join(root, "escdeep"));
    await expect(
      resolveWithinWorkingDir(root, "escdeep/newdir/leaf.md"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("throws CONFIG when the working dir is missing", async () => {
    await expect(
      resolveWithinWorkingDir(
        path.join(os.tmpdir(), "lp-does-not-exist-zzz-xyz"),
        "a.txt",
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});
