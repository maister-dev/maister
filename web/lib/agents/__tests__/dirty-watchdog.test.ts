import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  filterManifestPorcelain,
  restoreAgentMaterialization,
} from "@/lib/agents/dirty-watchdog";
import { PACKAGE_SKILLS_MANIFEST_RELATIVE } from "@/lib/agents/materialization-manifest";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dirty-watchdog-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("package skill materialization manifest", () => {
  it("restores only MAIster-owned package materialization and keeps user-owned entries", async () => {
    const materializedSkill = path.join(
      root,
      ".claude",
      "skills",
      "aif-review",
    );
    const materializedAgent = path.join(root, ".claude", "agents", "helper.md");
    const userSkill = path.join(root, ".claude", "skills", "local-review");
    const userAgent = path.join(root, ".claude", "agents", "local.md");

    await mkdir(materializedSkill, { recursive: true });
    await mkdir(path.dirname(materializedAgent), { recursive: true });
    await mkdir(userSkill, { recursive: true });
    await mkdir(path.dirname(userAgent), { recursive: true });
    await writeFile(path.join(materializedSkill, "SKILL.md"), "materialized");
    await writeFile(materializedAgent, "materialized");
    await writeFile(path.join(userSkill, "SKILL.md"), "user-owned");
    await writeFile(userAgent, "user-owned");
    await mkdir(
      path.dirname(path.join(root, PACKAGE_SKILLS_MANIFEST_RELATIVE)),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(root, PACKAGE_SKILLS_MANIFEST_RELATIVE),
      `${JSON.stringify(
        { paths: [".claude/skills/aif-review", ".claude/agents/helper.md"] },
        null,
        2,
      )}\n`,
    );

    await restoreAgentMaterialization(root);

    await expect(stat(materializedSkill)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(materializedAgent)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(root, PACKAGE_SKILLS_MANIFEST_RELATIVE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(userSkill, "SKILL.md"), "utf8")).toBe(
      "user-owned",
    );
    expect(await readFile(userAgent, "utf8")).toBe("user-owned");
  });

  it("ignores manifest paths that escape the session cwd during restore", async () => {
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-outside`,
    );

    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "KEEP"), "user-owned");
    await mkdir(
      path.dirname(path.join(root, PACKAGE_SKILLS_MANIFEST_RELATIVE)),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(root, PACKAGE_SKILLS_MANIFEST_RELATIVE),
      `${JSON.stringify({ paths: [`../${path.basename(outside)}`] }, null, 2)}\n`,
    );

    await restoreAgentMaterialization(root);

    expect(await readFile(path.join(outside, "KEEP"), "utf8")).toBe(
      "user-owned",
    );
    await rm(outside, { recursive: true, force: true });
  });

  it("filters MAIster-owned package skill paths from porcelain only when listed", () => {
    const porcelain = [
      "?? .maister/agent-package-skills.json",
      "?? .claude/skills/aif-review/SKILL.md",
      "?? .claude/agents/helper.md",
      "?? .claude/skills/local-review/SKILL.md",
    ].join("\n");

    expect(
      filterManifestPorcelain(porcelain, [
        ".claude/skills/aif-review",
        ".claude/agents/helper.md",
      ]),
    ).toBe("?? .claude/skills/local-review/SKILL.md");
  });

  it("does not let an empty manifest path hide all porcelain", () => {
    const porcelain = [
      "?? .maister/agent-package-skills.json",
      "?? src/changed.ts",
    ].join("\n");

    expect(filterManifestPorcelain(porcelain, [""])).toBe("?? src/changed.ts");
  });

  it("does not filter sibling paths by substring prefix", () => {
    const porcelain = [
      "?? .claude/skills/aif-review/SKILL.md",
      "?? .claude/skills/aif-reviewer/SKILL.md",
    ].join("\n");

    expect(
      filterManifestPorcelain(porcelain, [".claude/skills/aif-review"]),
    ).toBe("?? .claude/skills/aif-reviewer/SKILL.md");
  });
});
