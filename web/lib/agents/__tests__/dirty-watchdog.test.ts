import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  filterManifestPorcelain,
  materializeAgentReadOnlySettings,
  restoreAgentMaterialization,
} from "@/lib/agents/dirty-watchdog";
import {
  AGENT_MATERIALIZATION_ROOT_RELATIVE,
  materializeWithAgentLease,
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
    const materializedSkill = path.join(
      root,
      ".claude",
      "skills",
      "aif-review",
    );
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
      stat(
        path.join(
          root,
          AGENT_MATERIALIZATION_ROOT_RELATIVE,
          "runs",
          "run-1.json",
        ),
      ),
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
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-outside`,
    );
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
      /symlinked path component/,
    );
    expect(await readFile(path.join(outside, "KEEP"), "utf8")).toBe(
      "user-owned",
    );
    await rm(outside, { recursive: true, force: true });
  });

  it("fails closed when an owned target has a symlinked parent", async () => {
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-parent`,
    );
    const relativePath = ".claude/skills/linked";
    const target = path.join(outside, "skills", "linked");
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);

    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "KEEP"), "user-owned");
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await symlink(outside, path.join(root, ".claude", "skills"));
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
      /symlinked path component/,
    );
    expect(await readFile(path.join(target, "KEEP"), "utf8")).toBe(
      "user-owned",
    );
    await rm(outside, { recursive: true, force: true });
  });

  it("preserves an uncommitted preparing path during recovery", async () => {
    const packageRoot = path.join(root, "package");
    const sourceSkill = path.join(packageRoot, "skills", "aif-review");
    const relativePath = ".claude/skills/aif-review";
    const targetSkill = path.join(root, relativePath);
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);

    await mkdir(sourceSkill, { recursive: true });
    await writeFile(path.join(sourceSkill, "SKILL.md"), "fresh");
    await mkdir(targetSkill, { recursive: true });
    await writeFile(path.join(targetSkill, "SKILL.md"), "partial");
    await mkdir(path.join(ownershipRoot, "runs"), { recursive: true });
    await writeFile(
      path.join(ownershipRoot, "runs", "run-1.json"),
      JSON.stringify({
        version: 1,
        runId: "run-1",
        state: "preparing",
        paths: [relativePath],
      }),
    );

    await materializeAdapterCapabilityHome({
      agent: "claude",
      worktreePath: root,
      runId: "run-1",
      installedPaths: [packageRoot],
    });

    expect(await readFile(path.join(targetSkill, "SKILL.md"), "utf8")).toBe(
      "partial",
    );
    await restoreAgentMaterialization(root, "run-1");
    expect(await readFile(path.join(targetSkill, "SKILL.md"), "utf8")).toBe(
      "partial",
    );
  });

  it("rolls back only zero-owner preparing intent paths", async () => {
    const unleasedRelativePath = ".claude/skills/interrupted";
    const foreignRelativePath = ".claude/skills/foreign";
    const unleasedTarget = path.join(root, unleasedRelativePath);
    const foreignTarget = path.join(root, foreignRelativePath);
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);
    const runRecord = path.join(ownershipRoot, "runs", "run-1.json");

    await mkdir(unleasedTarget, { recursive: true });
    await mkdir(foreignTarget, { recursive: true });
    await writeFile(path.join(unleasedTarget, "SKILL.md"), "partial");
    await writeFile(path.join(foreignTarget, "SKILL.md"), "foreign-owner");
    await mkdir(path.dirname(runRecord), { recursive: true });
    await writeFile(
      path.join(ownershipRoot, "index.json"),
      JSON.stringify({
        version: 1,
        leases: { [foreignRelativePath]: ["foreign-run"] },
      }),
    );
    await writeFile(
      runRecord,
      JSON.stringify({
        version: 1,
        runId: "run-1",
        state: "preparing",
        paths: [unleasedRelativePath, foreignRelativePath],
      }),
    );

    await restoreAgentMaterialization(root, "run-1");

    await expect(stat(unleasedTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(foreignTarget, "SKILL.md"), "utf8")).resolves.toBe(
      "foreign-owner",
    );
    await expect(stat(runRecord)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes a releasing record whose index update already committed", async () => {
    const relativePath = ".claude/skills/released";
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);
    const runRecord = path.join(ownershipRoot, "runs", "run-1.json");

    await mkdir(path.dirname(runRecord), { recursive: true });
    await writeFile(
      path.join(ownershipRoot, "index.json"),
      JSON.stringify({ version: 1, leases: {} }),
    );
    await writeFile(
      runRecord,
      JSON.stringify({
        version: 1,
        runId: "run-1",
        state: "releasing",
        paths: [relativePath],
      }),
    );

    await restoreAgentMaterialization(root, "run-1");

    await expect(stat(runRecord)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails loudly when a releasing record retains an unleased target", async () => {
    const relativePath = ".claude/skills/released";
    const target = path.join(root, relativePath);
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);
    const runRecord = path.join(ownershipRoot, "runs", "run-1.json");

    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "preserve");
    await mkdir(path.dirname(runRecord), { recursive: true });
    await writeFile(
      path.join(ownershipRoot, "index.json"),
      JSON.stringify({ version: 1, leases: {} }),
    );
    await writeFile(
      runRecord,
      JSON.stringify({
        version: 1,
        runId: "run-1",
        state: "releasing",
        paths: [relativePath],
      }),
    );

    await expect(restoreAgentMaterialization(root, "run-1")).rejects.toThrow(
      /releasing target still exists without a lease/,
    );
    await expect(readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toBe(
      "preserve",
    );
    await expect(readFile(runRecord, "utf8")).resolves.toContain(
      '"state":"releasing"',
    );
  });

  it("keeps an active target when its ownership index is corrupt", async () => {
    const relativePath = ".claude/skills/unindexed";
    const target = path.join(root, relativePath);
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);

    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "preserve");
    await mkdir(path.join(ownershipRoot, "runs"), { recursive: true });
    await writeFile(
      path.join(ownershipRoot, "index.json"),
      JSON.stringify({ version: 1, leases: {} }),
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
      /lease is missing/,
    );
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(
      "preserve",
    );
  });

  it("keeps an active record and every target intact when cleanup prevalidation fails", async () => {
    const validRelativePath = ".claude/skills/valid";
    const unsafeRelativePath = ".claude/skills/unsafe";
    const validTarget = path.join(root, validRelativePath);
    const unsafeTarget = path.join(root, unsafeRelativePath);
    const outside = path.join(root, "outside");
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);
    const runRecord = path.join(ownershipRoot, "runs", "run-1.json");

    await mkdir(validTarget, { recursive: true });
    await writeFile(path.join(validTarget, "SKILL.md"), "keep");
    await mkdir(outside, { recursive: true });
    await mkdir(path.dirname(unsafeTarget), { recursive: true });
    await symlink(outside, unsafeTarget);
    await mkdir(path.dirname(runRecord), { recursive: true });
    await writeFile(
      path.join(ownershipRoot, "index.json"),
      JSON.stringify({
        version: 1,
        leases: {
          [validRelativePath]: ["run-1"],
          [unsafeRelativePath]: ["run-1"],
        },
      }),
    );
    await writeFile(
      runRecord,
      JSON.stringify({
        version: 1,
        runId: "run-1",
        state: "active",
        paths: [validRelativePath, unsafeRelativePath],
      }),
    );

    await expect(restoreAgentMaterialization(root, "run-1")).rejects.toThrow(
      /symlinked path component/,
    );
    await expect(readFile(path.join(validTarget, "SKILL.md"), "utf8")).resolves.toBe(
      "keep",
    );
    await expect(readFile(runRecord, "utf8")).resolves.toContain(
      '"state":"active"',
    );

    await rm(unsafeTarget, { force: true });
    await mkdir(unsafeTarget);
    await expect(
      materializeWithAgentLease({
        cwd: root,
        runId: "run-1",
        materialize: async () => [validTarget, unsafeTarget],
      }),
    ).resolves.toEqual(expect.arrayContaining([validTarget, unsafeTarget]));
  });

  it("preserves a foreign-leased path while recovering another run's intent", async () => {
    const relativePath = ".claude/skills/shared";
    const target = path.join(root, relativePath);
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);

    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "run-a");
    await mkdir(path.join(ownershipRoot, "runs"), { recursive: true });
    await writeFile(
      path.join(ownershipRoot, "index.json"),
      JSON.stringify({
        version: 1,
        leases: { [relativePath]: ["run-a"] },
      }),
    );
    await writeFile(
      path.join(ownershipRoot, "runs", "run-a.json"),
      JSON.stringify({
        version: 1,
        runId: "run-a",
        state: "active",
        paths: [relativePath],
      }),
    );
    await writeFile(
      path.join(ownershipRoot, "runs", "run-b.json"),
      JSON.stringify({
        version: 1,
        runId: "run-b",
        state: "preparing",
        paths: [relativePath],
      }),
    );

    await materializeWithAgentLease({
      cwd: root,
      runId: "run-b",
      materialize: async () => {
        expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(
          "run-a",
        );

        return [target];
      },
    });

    const index = JSON.parse(
      await readFile(path.join(ownershipRoot, "index.json"), "utf8"),
    ) as { readonly leases: Record<string, readonly string[]> };

    expect(index.leases[relativePath]).toEqual(["run-a", "run-b"]);
  });

  it("takes over a stale ownerless materialization lock", async () => {
    const lockPath = path.join(
      root,
      AGENT_MATERIALIZATION_ROOT_RELATIVE,
      "lock",
    );
    const staleAt = new Date(Date.now() - 10_000);

    await mkdir(lockPath, { recursive: true });
    await utimes(lockPath, staleAt, staleAt);

    await expect(
      materializeWithAgentLease({
        cwd: root,
        runId: "run-1",
        materialize: async () => [],
      }),
    ).resolves.toEqual([]);
  });

  it("refuses a symlinked materialization metadata root", async () => {
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-metadata`,
    );

    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, ".maister"));

    await expect(
      materializeWithAgentLease({
        cwd: root,
        runId: "run-1",
        materialize: async () => [],
      }),
    ).rejects.toThrow(/symlinked path component/);
    await expect(
      stat(path.join(outside, "agent-materialization")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await rm(outside, { recursive: true, force: true });
  });

  it("refuses a symlinked cwd before materialization or release can touch its target", async () => {
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-cwd-target`,
    );
    const linkedCwd = path.join(
      path.dirname(root),
      `${path.basename(root)}-cwd-link`,
    );

    await mkdir(outside, { recursive: true });
    await symlink(outside, linkedCwd);

    await expect(
      materializeWithAgentLease({
        cwd: linkedCwd,
        runId: "run-1",
        materialize: async () => [],
      }),
    ).rejects.toThrow(/cwd is unsafe/);
    await expect(restoreAgentMaterialization(linkedCwd, "run-1")).rejects.toThrow(
      /cwd is unsafe/,
    );
    await expect(
      stat(path.join(outside, AGENT_MATERIALIZATION_ROOT_RELATIVE)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await rm(linkedCwd, { force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("refuses a symlinked run-record directory below the metadata root", async () => {
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-run-records`,
    );
    const ownershipRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE);

    await mkdir(outside, { recursive: true });
    await mkdir(ownershipRoot, { recursive: true });
    await symlink(outside, path.join(ownershipRoot, "runs"));
    await writeFile(
      path.join(outside, "run-1.json"),
      JSON.stringify({
        version: 1,
        runId: "run-1",
        state: "active",
        paths: [],
      }),
    );

    await expect(restoreAgentMaterialization(root, "run-1")).rejects.toThrow(
      /symlinked path component/,
    );
    expect(await stat(path.join(outside, "run-1.json"))).toBeDefined();
    await rm(outside, { recursive: true, force: true });
  });

  it("accumulates repeated intents for crash rollback", async () => {
    const first = path.join(root, ".claude/skills/first");
    const second = path.join(root, ".claude/skills/second");

    await expect(
      materializeWithAgentLease({
        cwd: root,
        runId: "run-1",
        materialize: async (_ownedPaths, recordIntent) => {
          await recordIntent([first]);
          await mkdir(first, { recursive: true });
          await recordIntent([second]);
          await mkdir(second, { recursive: true });
          throw new Error("simulated materializer crash");
        },
      }),
    ).rejects.toThrow("simulated materializer crash");

    await materializeWithAgentLease({
      cwd: root,
      runId: "run-1",
      materialize: async () => {
        expect(await stat(first)).toBeDefined();
        expect(await stat(second)).toBeDefined();

        return [];
      },
    });
  });

  it("reports L2 settings as materialized when the run already owns package paths", async () => {
    const packageRoot = path.join(root, "package");
    const sourceSkill = path.join(packageRoot, "skills", "aif-review");

    await mkdir(sourceSkill, { recursive: true });
    await writeFile(path.join(sourceSkill, "SKILL.md"), "materialized");
    await materializeAdapterCapabilityHome({
      agent: "claude",
      worktreePath: root,
      runId: "run-1",
      installedPaths: [packageRoot],
    });

    await expect(
      materializeAgentReadOnlySettings(root, "claude", "run-1"),
    ).resolves.toEqual({ materialized: true });
  });

  it("filters MAIster-owned package skill paths from porcelain only when listed", () => {
    const porcelain = [
      "?? .maister/agent-materialization/index.json",
      "?? .claude/settings.local.json.maister-bak",
      "?? .claude/settings.local.json.maister-operation",
      "?? .claude/skills/aif-review/SKILL.md",
      "?? .claude/agents/helper.md",
      "?? .claude/skills/local-review/SKILL.md",
    ].join("\n");

    expect(
      filterManifestPorcelain(porcelain, [
        ".maister/agent-materialization/index.json",
        ".claude/settings.local.json.maister-bak",
        ".claude/settings.local.json.maister-operation",
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

    expect(filterManifestPorcelain(porcelain, [""])).toBe(
      "?? .maister/agent-materialization/index.json\n?? src/changed.ts",
    );
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

  it("keeps a rename dirty when either source or destination is user-owned", () => {
    const movedIntoOwnedPath =
      "R  src/user-work.ts -> .maister/agent-materialization/index.json";
    const movedOutOfOwnedPath =
      "R  .maister/agent-materialization/index.json -> src/user-work.ts";

    expect(
      filterManifestPorcelain(movedIntoOwnedPath, [
        ".maister/agent-materialization/index.json",
      ]),
    ).toBe(movedIntoOwnedPath);
    expect(
      filterManifestPorcelain(movedOutOfOwnedPath, [
        ".maister/agent-materialization/index.json",
      ]),
    ).toBe(movedOutOfOwnedPath);
  });
});
