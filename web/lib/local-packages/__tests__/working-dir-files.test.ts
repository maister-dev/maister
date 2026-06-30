import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteWorkingDirFile,
  listFiles,
  readFileContent,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";

// M36 T2.3 — the confined working-dir write/delete the file routes call after
// asserting the session lock. Only pkg.workingDir is used, so a partial stands
// in for the row.
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lpw-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function pkg() {
  return { workingDir: dir } as never;
}

describe("writeWorkingDirFile / deleteWorkingDirFile (M36 T2.3)", () => {
  it("writes a confined file (creating parent dirs) and returns its hash", async () => {
    const result = await writeWorkingDirFile(pkg(), "skills/s1/SKILL.md", "hi");

    expect(result.path).toBe("skills/s1/SKILL.md");
    expect(result.kind).toBe("skill");
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(dir, "skills/s1/SKILL.md"), "utf8")).toBe("hi");
  });

  it("rejects a path escaping the working dir (write and delete)", async () => {
    await expect(
      writeWorkingDirFile(pkg(), "../escape.md", "x"),
    ).rejects.toThrow();
    await expect(deleteWorkingDirFile(pkg(), "../escape.md")).rejects.toThrow();
  });

  it("rejects a .git path", async () => {
    await expect(
      writeWorkingDirFile(pkg(), ".git/config", "x"),
    ).rejects.toThrow();
  });

  it("rejects local runtime metadata paths", async () => {
    await expect(
      writeWorkingDirFile(pkg(), ".maister/run.json", "x"),
    ).rejects.toThrow();
    await expect(
      writeWorkingDirFile(pkg(), ".claude/skills/flow-authoring/SKILL.md", "x"),
    ).rejects.toThrow();
  });

  it("does not list assistant runtime files as package artifacts", async () => {
    await writeWorkingDirFile(pkg(), "maister-package.yaml", "name: x\n");
    await mkdir(
      join(
        dir,
        ".maister/capabilities/run-1/codex-home/.tmp/plugins-clone-x/.git",
      ),
      { recursive: true },
    );
    await writeFile(
      join(
        dir,
        ".maister/capabilities/run-1/codex-home/.tmp/plugins-clone-x/.git/config",
      ),
      "runtime git config",
    );
    await mkdir(join(dir, ".claude/skills/flow-authoring"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".claude/skills/flow-authoring/SKILL.md"),
      "runtime skill",
    );

    const files = await listFiles(pkg());

    expect(files.map((f) => f.path)).toEqual(["maister-package.yaml"]);
    await expect(
      readFileContent(
        pkg(),
        ".maister/capabilities/run-1/codex-home/.tmp/plugins-clone-x/.git/config",
      ),
    ).rejects.toThrow();
    await expect(
      readFileContent(pkg(), ".claude/skills/flow-authoring/SKILL.md"),
    ).rejects.toThrow();
  });

  it("deletes idempotently — a missing file is not an error", async () => {
    await writeWorkingDirFile(pkg(), "rules/r.md", "rule");
    await deleteWorkingDirFile(pkg(), "rules/r.md");

    await expect(
      deleteWorkingDirFile(pkg(), "rules/r.md"),
    ).resolves.toBeUndefined();
  });
});
