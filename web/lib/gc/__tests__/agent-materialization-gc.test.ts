import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_MATERIALIZATION_ROOT_RELATIVE,
  materializeWithAgentLease,
} from "@/lib/agents/materialization-manifest";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";
import {
  materializeCapabilitySettings,
  SETTINGS_RELATIVE,
} from "@/lib/capabilities/settings-ownership";
import {
  discoverAgentMaterializationCandidateRoots,
  runAgentMaterializationCleanupSweep,
} from "@/lib/gc/agent-materialization-gc";

let root: string;

beforeEach(async () => {
  // realpath so the macOS /var -> /private/var tmp symlink does not trip the
  // in-worktree path-safety checks (production worktrees are not symlinked).
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "materialization-gc-")),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedRecord(runId: string): Promise<void> {
  const runsRoot = path.join(root, AGENT_MATERIALIZATION_ROOT_RELATIVE, "runs");

  await mkdir(runsRoot, { recursive: true });
  await writeFile(
    path.join(runsRoot, `${runId}.json`),
    JSON.stringify({ version: 1, runId, state: "active", paths: [] }),
  );
}

describe("agent materialization cleanup sweep", () => {
  it("discovers local-package working directories alongside project and workspace roots", async () => {
    const projectRoot = path.join(root, "project");
    const workspaceRoot = path.join(root, "workspace");
    const localPackageRoot = path.join(root, "local-package");
    const from = vi
      .fn()
      .mockResolvedValueOnce([{ slug: "p", repoPath: projectRoot }])
      .mockResolvedValueOnce([{ worktreePath: workspaceRoot }])
      .mockResolvedValueOnce([{ workingDir: localPackageRoot }]);
    const db = {
      select: vi.fn(() => ({ from })),
    };

    await expect(
      discoverAgentMaterializationCandidateRoots(db),
    ).resolves.toEqual([localPackageRoot, projectRoot, workspaceRoot]);
  });

  it("retries terminal, missing, and unresumable crashed runs while preserving reopenable worktrees", async () => {
    await Promise.all([
      seedRecord("terminal"),
      seedRecord("missing"),
      seedRecord("review"),
      seedRecord("crashed-none"),
      seedRecord("crashed-repo-read"),
      seedRecord("crashed-worktree"),
    ]);
    const restore = vi.fn(async () => undefined);

    await expect(
      runAgentMaterializationCleanupSweep({
        candidateRoots: [root],
        loadStatuses: async () =>
          new Map([
            ["terminal", { status: "Done", agentWorkspace: "none" }],
            ["review", { status: "Review", agentWorkspace: "worktree" }],
            ["crashed-none", { status: "Crashed", agentWorkspace: "none" }],
            [
              "crashed-repo-read",
              { status: "Crashed", agentWorkspace: "repo_read" },
            ],
            [
              "crashed-worktree",
              { status: "Crashed", agentWorkspace: "worktree" },
            ],
          ]),
        restore,
      }),
    ).resolves.toEqual({ scanned: 6, restored: 4, live: 2, failed: 0 });
    expect(restore.mock.calls).toEqual([
      [root, "crashed-none"],
      [root, "crashed-repo-read"],
      [root, "missing"],
      [root, "terminal"],
    ]);
  });

  it("continues after a cleanup failure so the record can retry later", async () => {
    await Promise.all([seedRecord("a"), seedRecord("b")]);
    const restore = vi.fn(async (_cwd: string, runId: string) => {
      if (runId === "a") throw new Error("corrupt ownership");
    });

    await expect(
      runAgentMaterializationCleanupSweep({
        candidateRoots: [root],
        loadStatuses: async () => new Map(),
        restore,
      }),
    ).resolves.toEqual({ scanned: 2, restored: 1, live: 0, failed: 1 });
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it("reclaims a pre-insert local capability profile from its missing-run lease", async () => {
    const runId = "orphan-profile";
    const capabilityRoot = capabilityMaterializationRootPath(root, runId);

    await materializeWithAgentLease({
      cwd: root,
      runId,
      materialize: async (_ownedPaths, recordIntent) => {
        await recordIntent([capabilityRoot]);
        await mkdir(capabilityRoot, { recursive: true });

        return [capabilityRoot];
      },
    });
    await materializeCapabilitySettings({
      cwd: root,
      runId,
      content: '{"profile":true}\n',
    });

    await expect(
      runAgentMaterializationCleanupSweep({
        candidateRoots: [root],
        loadStatuses: async () => new Map(),
      }),
    ).resolves.toEqual({ scanned: 1, restored: 1, live: 0, failed: 0 });
    await expect(stat(capabilityRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(root, SETTINGS_RELATIVE)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
