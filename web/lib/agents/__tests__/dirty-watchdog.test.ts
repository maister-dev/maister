import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  filterManifestPorcelain,
  restoreAgentMaterialization,
} from "@/lib/agents/dirty-watchdog";
import {
  AGENT_MATERIALIZATION_ROOT_RELATIVE,
  normalizeAgentMaterializationPath,
} from "@/lib/agents/materialization-manifest";
import { materializeAdapterCapabilityHome } from "@/lib/capabilities/adapter-home";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dirty-watchdog-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("package skill materialization manifest", () => {
  it("restores only MAIster-owned package materialization and keeps user-owned entries", async () => {
    const packageRoot = path.join(root, "package");
    const sourceSkill = path.join(packageRoot, "skills", "aif-review");
    const sourceAgent = path.join(packageRoot, "agents", "helper.md");
    const materializedSkill = path.join(root, ".claude", "skills", "aif-review");
    const materializedAgent = path.join(root, ".claude", "agents", "helper.md");
    const userSkill = path.join(root, ".claude", "skills", "local-review");
    const userAgent = path.join(root, ".claude", "agents", "local.md");

    await mkdir(sourceSkill, { recursive: true });
    await mkdir(path.dirname(sourceAgent), { recursive: true });
    await mkdir(userSkill, { recursive: true });
    await mkdir(path.dirname(userAgent), { recursive: true });
    await writeFile(path.join(sourceSkill, "SKILL.md"), "materialized");
    await writeFile(sourceAgent, "materialized");
    await writeFile(path.join(userSkill, "SKILL.md"), "user-owned");
    await writeFile(userAgent, "user-owned");
    await materializeAdapterCapabilityHome({
      agent: "claude",
      worktreePath: root,
      runId: "run-1",
      installedPaths: [packageRoot],
    });

    await restoreAgentMaterialization(root, "run-1");

    await expect(stat(materializedSkill)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(materializedAgent)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE, "runs", "run-1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(userSkill, "SKILL.md"), "utf8")).toBe(
      "user-owned",
    );
    expect(await readFile(userAgent, "utf8")).toBe("user-owned");
  });

  it.each(["", "../outside", "/absolute", ".", ".claude/skills/../outside"])(
    "rejects unsafe ownership path %j",
    (unsafePath) => {
      expect(() => normalizeAgentMaterializationPath(unsafePath)).toThrow();
    },
  );

  it("keeps a shared path until the last concurrent run releases its lease", async () => {
    const packageRoot = path.join(root, "package");
    const sourceSkill = path.join(packageRoot, "skills", "aif-review");
    const targetSkill = path.join(root, ".claude", "skills", "aif-review");

    await mkdir(sourceSkill, { recursive: true });
    await writeFile(path.join(sourceSkill, "SKILL.md"), "materialized");

    await Promise.all([
      materializeAdapterCapabilityHome({
        agent: "claude",
        worktreePath: root,
        runId: "run-1",
        installedPaths: [packageRoot],
      }),
      materializeAdapterCapabilityHome({
        agent: "claude",
        worktreePath: root,
        runId: "run-2",
        installedPaths: [packageRoot],
      }),
    ]);

    await restoreAgentMaterialization(root, "run-1");
    expect(await readFile(path.join(targetSkill, "SKILL.md"), "utf8")).toBe(
      "materialized",
    );

    await restoreAgentMaterialization(root, "run-2");
    await expect(stat(targetSkill)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a symlinked owned target and preserves the target content", async () => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
    const relativePath = ".claude/skills/linked";
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);

    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "KEEP"), "user-owned");
    await mkdir(path.join(root, ".claude", "skills"), { recursive: true });
    await symlink(outside, path.join(root, relativePath));
    await mkdir(path.join(ownershipRoot, "runs"), { recursive: true });
    await writeFile(
      path.join(ownershipRoot, "index.json"),
      JSON.stringify({ version: 1, leases: { [relativePath]: ["run-1"] } }),
    );
    await writeFile(
      path.join(ownershipRoot, "runs", "run-1.json"),
      JSON.stringify({
        version: 1,
        runId: "run-1",
        state: "active",
        paths: [relativePath],
      }),
    );

    await expect(restoreAgentMaterialization(root, "run-1")).rejects.toThrow(
      /symlinked materialization target/,
    );
    expect(await readFile(path.join(outside, "KEEP"), "utf8")).toBe(
      "user-owned",
    );
    await rm(outside, { recursive: true, force: true });
  });

  it("filters MAIster-owned package skill paths from porcelain only when listed", () => {
    const porcelain = [
      "?? .maister/agent-materialization/index.json",
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
      "?? .maister/agent-materialization/index.json",
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
