import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { mergeTrees } from "@/lib/local-packages/sync-merge";

// ADR-129 §d (T19): the synthetic 3-way merge over exported trees — base =
// the fork's ORIGINAL source install bytes, theirs = the sync-target install
// bytes, ours = the fork working dir (mutated IN PLACE). Pure lib: no DB, no
// git history required — `git merge-file` only for textual per-file merges.
// One test per case-table row; the table is the contract.

let baseDir: string;
let theirsDir: string;
let oursDir: string;

async function seed(root: string, rel: string, content: string | Uint8Array) {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content);
}

async function readOurs(rel: string): Promise<string> {
  return readFile(join(oursDir, rel), "utf8");
}

async function oursExists(rel: string): Promise<boolean> {
  try {
    await readFile(join(oursDir, rel));

    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "sm-base-"));
  theirsDir = await mkdtemp(join(tmpdir(), "sm-theirs-"));
  oursDir = await mkdtemp(join(tmpdir(), "sm-ours-"));
});

afterEach(async () => {
  for (const dir of [baseDir, theirsDir, oursDir]) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function run() {
  return mergeTrees({
    baseDir,
    theirsDir,
    oursDir,
    markerLabel: "upstream v2",
  });
}

describe("mergeTrees case table", () => {
  it("unchanged ours + changed theirs → take theirs (clean)", async () => {
    await seed(baseDir, "f.txt", "v1\n");
    await seed(theirsDir, "f.txt", "v2\n");
    await seed(oursDir, "f.txt", "v1\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: ["f.txt"], conflictedFiles: [] });
    expect(await readOurs("f.txt")).toBe("v2\n");
  });

  it("changed ours + unchanged theirs → keep ours (no-op)", async () => {
    await seed(baseDir, "f.txt", "v1\n");
    await seed(theirsDir, "f.txt", "v1\n");
    await seed(oursDir, "f.txt", "mine\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: [] });
    expect(await readOurs("f.txt")).toBe("mine\n");
  });

  it("both changed to the SAME content → keep (converged, no-op)", async () => {
    await seed(baseDir, "f.txt", "v1\n");
    await seed(theirsDir, "f.txt", "same\n");
    await seed(oursDir, "f.txt", "same\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: [] });
    expect(await readOurs("f.txt")).toBe("same\n");
  });

  it("both changed DIFFERENT non-overlapping lines → git merge-file clean", async () => {
    const base = "line1\nline2\nline3\nline4\nline5\n";

    await seed(baseDir, "f.txt", base);
    await seed(theirsDir, "f.txt", base.replace("line1", "THEIRS1"));
    await seed(oursDir, "f.txt", base.replace("line5", "OURS5"));

    const result = await run();

    expect(result).toEqual({ cleanFiles: ["f.txt"], conflictedFiles: [] });
    expect(await readOurs("f.txt")).toBe(
      "THEIRS1\nline2\nline3\nline4\nOURS5\n",
    );
  });

  it("both changed the SAME lines → conflict markers written into ours (git merge-file defaults)", async () => {
    await seed(baseDir, "f.txt", "v1\n");
    await seed(theirsDir, "f.txt", "theirs\n");
    await seed(oursDir, "f.txt", "ours\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: ["f.txt"] });
    const merged = await readOurs("f.txt");

    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain("ours\n");
    expect(merged).toContain("=======");
    expect(merged).toContain("theirs\n");
    expect(merged).toContain(">>>>>>> upstream v2");
  });

  it("added in theirs only → add", async () => {
    await seed(theirsDir, "new.txt", "from upstream\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: ["new.txt"], conflictedFiles: [] });
    expect(await readOurs("new.txt")).toBe("from upstream\n");
  });

  it("added in ours only → keep", async () => {
    await seed(oursDir, "mine.txt", "fork-only\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: [] });
    expect(await readOurs("mine.txt")).toBe("fork-only\n");
  });

  it("added in both IDENTICAL → keep (converged)", async () => {
    await seed(theirsDir, "both.txt", "same\n");
    await seed(oursDir, "both.txt", "same\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: [] });
  });

  it("added in both DIFFERENT → add/add conflict via empty base", async () => {
    await seed(theirsDir, "both.txt", "upstream version\n");
    await seed(oursDir, "both.txt", "fork version\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: ["both.txt"] });
    const merged = await readOurs("both.txt");

    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain("fork version\n");
    expect(merged).toContain("upstream version\n");
    expect(merged).toContain(">>>>>>> upstream v2");
  });

  it("deleted in theirs + ours unchanged → delete", async () => {
    await seed(baseDir, "gone.txt", "v1\n");
    await seed(oursDir, "gone.txt", "v1\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: ["gone.txt"], conflictedFiles: [] });
    expect(await oursExists("gone.txt")).toBe(false);
  });

  it("deleted in theirs + ours CHANGED → modify/delete conflict, ours kept", async () => {
    await seed(baseDir, "kept.txt", "v1\n");
    await seed(oursDir, "kept.txt", "edited by fork\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: ["kept.txt"] });
    expect(await readOurs("kept.txt")).toBe("edited by fork\n");
  });

  it("deleted in ours + theirs CHANGED → delete/modify conflict, NOT resurrected", async () => {
    await seed(baseDir, "dropped.txt", "v1\n");
    await seed(theirsDir, "dropped.txt", "v2\n");

    const result = await run();

    expect(result).toEqual({
      cleanFiles: [],
      conflictedFiles: ["dropped.txt"],
    });
    expect(await oursExists("dropped.txt")).toBe(false);
  });

  it("deleted in ours + theirs UNCHANGED → stays deleted (fork's deletion wins, no-op)", async () => {
    await seed(baseDir, "removed.txt", "v1\n");
    await seed(theirsDir, "removed.txt", "v1\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: [] });
    expect(await oursExists("removed.txt")).toBe(false);
  });

  it("deleted in BOTH → converged, no-op", async () => {
    await seed(baseDir, "both-gone.txt", "v1\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: [] });
  });

  it("binary (NUL-sniff) differing → conflict entry, ours kept byte-identical", async () => {
    const oursBytes = new Uint8Array([0x50, 0x00, 0x4f, 0x55, 0x52, 0x53]);

    await seed(baseDir, "asset.bin", new Uint8Array([0x50, 0x00, 0x42]));
    await seed(theirsDir, "asset.bin", new Uint8Array([0x50, 0x00, 0x54]));
    await seed(oursDir, "asset.bin", oursBytes);

    const result = await run();

    expect(result).toEqual({
      cleanFiles: [],
      conflictedFiles: ["asset.bin"],
    });
    const kept = await readFile(join(oursDir, "asset.bin"));

    expect(kept.equals(oursBytes)).toBe(true);
  });

  it("runtime dirs (.git/.maister/.claude) are never merged", async () => {
    await seed(theirsDir, ".git/config", "core\n");
    await seed(theirsDir, ".maister/state.json", "{}\n");
    await seed(oursDir, ".claude/settings.json", "{}\n");

    const result = await run();

    expect(result).toEqual({ cleanFiles: [], conflictedFiles: [] });
    expect(await oursExists(".git/config")).toBe(false);
  });

  it("IDEMPOTENT: re-running on the already-merged clean result is a no-op", async () => {
    await seed(baseDir, "take.txt", "v1\n");
    await seed(theirsDir, "take.txt", "v2\n");
    await seed(oursDir, "take.txt", "v1\n");
    await seed(theirsDir, "add.txt", "new\n");
    await seed(baseDir, "del.txt", "v1\n");
    await seed(oursDir, "del.txt", "v1\n");

    const first = await run();

    expect(first.cleanFiles.sort()).toEqual(["add.txt", "del.txt", "take.txt"]);
    expect(first.conflictedFiles).toEqual([]);

    const second = await run();

    expect(second).toEqual({ cleanFiles: [], conflictedFiles: [] });
    expect(await readOurs("take.txt")).toBe("v2\n");
    expect(await readOurs("add.txt")).toBe("new\n");
    expect(await oursExists("del.txt")).toBe(false);
  });
});
