import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { materializeOperationalContextMounts } from "@/lib/context-mounts/service";
import { materializeOperationalAdapterCapabilityHome } from "@/lib/capabilities/adapter-home";
import { materializeAgentReadOnlySettings } from "@/lib/agents/dirty-watchdog";
import {
  agentMaterializationPathsForRun,
  releaseAgentMaterialization,
} from "@/lib/agents/materialization-manifest";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
  verifyOperationalIntegrity,
} from "@/lib/agents/operational-integrity";

const exec = promisify(execFile);
let root: string;
let cwd: string;
const git = async (...args: string[]): Promise<void> => {
  await exec("git", ["-C", cwd, ...args]);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "operational-integrity-"));
  cwd = join(root, "repo");
  await mkdir(cwd);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "operation@example.test");
  await git("config", "user.name", "Operation test");
  await writeFile(join(cwd, "source.ts"), "export const value = 1;\n");
  await writeFile(join(cwd, ".gitignore"), "ignored.bin\n");
  await git("add", ".");
  await git("commit", "-qm", "initial");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("operational source integrity", () => {
  it("prepares real Claude package skills without changing source gitignore or index and still refuses unowned writes", async () => {
    const materializationCwd = await realpath(cwd);
    const bundle = join(root, "bundle");
    const runId = randomUUID();

    await mkdir(join(bundle, "skills", "qualify"), { recursive: true });
    await writeFile(
      join(bundle, "skills", "qualify", "SKILL.md"),
      "---\nname: qualify\ndescription: fixture\n---\nInspect source.\n",
    );
    const baseline = await captureOperationalBaseline(
      materializationCwd,
      "ephemeral_checkout",
    );
    const gitignore = await readFile(join(cwd, ".gitignore"));
    const index = await readFile(join(cwd, ".git", "index"));

    await materializeAgentReadOnlySettings(materializationCwd, "claude", runId);
    const home = await materializeOperationalAdapterCapabilityHome({
      agent: "claude",
      worktreePath: materializationCwd,
      runId,
      installedPaths: [bundle],
    });

    expect(home.materializedRoots).toContain(
      join(materializationCwd, ".claude", "skills", "qualify"),
    );
    expect(await readFile(join(cwd, ".gitignore"))).toEqual(gitignore);
    expect(await readFile(join(cwd, ".git", "index"))).toEqual(index);
    const ownedPaths = await agentMaterializationPathsForRun(
      materializationCwd,
      runId,
    );
    const generationPaths = [
      ...ownedPaths,
      ".maister/agent-materialization/index.json",
      `.maister/agent-materialization/runs/${runId}.json`,
      ".maister/agent-materialization/mutex.sqlite",
      ".maister/agent-materialization/mutex.sqlite-journal",
      ".maister/agent-materialization/mutex.sqlite-shm",
      ".maister/agent-materialization/mutex.sqlite-wal",
    ];
    const ready = await captureOperationalGeneration(
      materializationCwd,
      baseline,
      generationPaths,
    );

    expect(ready.generation).toBe(1);
    expect(
      (await verifyOperationalIntegrity(materializationCwd, ready)).verdict,
    ).toBe("clean");
    await writeFile(join(cwd, "unowned-source.txt"), "Unexpected write.\n");
    await expect(
      captureOperationalGeneration(materializationCwd, ready, generationPaths),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "operational_materialization_conflict" },
    });
    await releaseAgentMaterialization(materializationCwd, runId);
    expect(await readFile(join(cwd, ".gitignore"))).toEqual(gitignore);
    expect(await readFile(join(cwd, ".git", "index"))).toEqual(index);
    expect(await readFile(join(cwd, "unowned-source.txt"), "utf8")).toBe(
      "Unexpected write.\n",
    );
  });

  it("TB05 preserves a real missing-root cause and probe operation without exposing filesystem paths", async () => {
    await rm(cwd, { recursive: true });

    let failure: unknown;

    try {
      await captureOperationalBaseline(cwd, "ephemeral_checkout");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "PRECONDITION",
      details: {
        reason: "operational_integrity_probe_failed",
        probeOperation: "lstat",
        causeChain: [{ name: "Error", code: "ENOENT", syscall: "lstat" }],
      },
      cause: { code: "ENOENT", syscall: "lstat" },
    });
    expect(
      JSON.stringify((failure as { details: object }).details),
    ).not.toContain(root);
  });

  it("TB05 retains a real Git exit category while redacting command diagnostics", async () => {
    await rename(join(cwd, ".git", "HEAD"), join(root, "saved-head"));
    let failure: unknown;

    try {
      await captureOperationalBaseline(cwd, "ephemeral_checkout");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "PRECONDITION",
      details: {
        reason: "operational_integrity_probe_failed",
        probeOperation: expect.stringMatching(/^git\./),
        causeChain: expect.arrayContaining([
          expect.objectContaining({ code: 128 }),
        ]),
      },
    });
    const details = JSON.stringify((failure as { details: object }).details);

    expect(details).not.toContain(root);
    expect(details).not.toContain("stderr");
  });

  it("bounds concurrent probe buffers while hashing distinct multi-block, empty, short and tiny files exactly", async () => {
    const fixtures = Array.from({ length: 4 }, (_, probe) => ({
      plain: join(root, `probe-${probe}`),
      files: [
        {
          name: "000-multi-block.bin",
          content: Buffer.alloc(2 * 1024 * 1024 + 17 + probe, 65 + probe),
        },
        { name: "001-empty.txt", content: "" },
        { name: "002-short.txt", content: `Short probe ${probe}\n` },
        ...Array.from({ length: 128 }, (_, index) => ({
          name: `source-${String(index).padStart(3, "0")}.txt`,
          content: `Probe ${probe} source ${index}\n`,
        })),
      ],
    }));

    for (const fixture of fixtures) {
      await mkdir(fixture.plain);
      await Promise.all(
        fixture.files.map((file) =>
          writeFile(join(fixture.plain, file.name), file.content),
        ),
      );
    }
    const allocation = vi.spyOn(Buffer, "alloc");
    let allocatedBytes = 0;

    try {
      const baselines = await Promise.all(
        fixtures.map((fixture) =>
          captureOperationalBaseline(fixture.plain, "plain_directory"),
        ),
      );

      for (const [index, baseline] of baselines.entries()) {
        const fixture = fixtures[index];
        const ready = await captureOperationalGeneration(
          fixture.plain,
          baseline,
          [],
        );

        expect(
          await verifyOperationalIntegrity(fixture.plain, ready),
        ).toMatchObject({
          verdict: "clean",
        });
        expect(baseline.source).toEqual(
          fixture.files.map((file) => ({
            path: file.name,
            type: "file",
            sha256: createHash("sha256").update(file.content).digest("hex"),
            mode: expect.any(Number),
          })),
        );
      }
      allocatedBytes = allocation.mock.calls.reduce(
        (total, [size]) => total + size,
        0,
      );
    } finally {
      allocation.mockRestore();
    }
    expect(allocatedBytes).toBeLessThanOrEqual(
      fixtures.length * 3 * 1024 * 1024,
    );
  });

  it("refuses existing operational context targets before creating or replacing any sibling", async () => {
    const first = join(root, "new-context");
    const head = (
      await exec("git", ["-C", cwd, "rev-parse", "HEAD"])
    ).stdout.trim();
    const mounts = [first, cwd].map((mountPath, index) => ({
      projectId: `project-${index}`,
      slug: `sibling-${index}`,
      repoPath: cwd,
      mountPath,
      committish: head,
    }));

    await expect(
      materializeOperationalContextMounts(mounts),
    ).rejects.toMatchObject({
      details: { reason: "operational_context_target_exists" },
    });
    await expect(lstat(first)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
  });

  it("IT-OPL-04 accepts exact platform bytes and rejects later changes even inside owned directories", async () => {
    const baseline = await captureOperationalBaseline(cwd, "worktree");

    await mkdir(join(cwd, ".claude", "skills", "scan"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "skills", "scan", "SKILL.md"),
      "Trusted materialization.\n",
    );
    const ready = await captureOperationalGeneration(cwd, baseline, [
      ".claude/skills/scan",
    ]);

    expect((await verifyOperationalIntegrity(cwd, ready)).verdict).toBe(
      "clean",
    );
    await writeFile(
      join(cwd, ".claude", "skills", "scan", "injected.ts"),
      "unexpected",
    );
    expect(await verifyOperationalIntegrity(cwd, ready)).toMatchObject({
      verdict: "changed",
      changedPaths: [".claude/skills/scan/injected.ts"],
    });
    await rm(join(cwd, ".claude", "skills", "scan", "injected.ts"));
    await writeFile(
      join(cwd, ".claude", "skills", "scan", "SKILL.md"),
      "Tampered platform bytes.",
    );
    expect(await verifyOperationalIntegrity(cwd, ready)).toMatchObject({
      verdict: "changed",
      changedPaths: [".claude/skills/scan/SKILL.md"],
    });
    expect(baseline.generation).toBe(0);
    expect(baseline.platform).toEqual([]);
  });

  it("IT-EDGE-OPL-04 rejects a replaced execution root and Git configuration drift", async () => {
    const baseline = await captureOperationalGeneration(
      cwd,
      await captureOperationalBaseline(cwd, "worktree"),
      [],
    );

    await git(
      "config",
      "remote.origin.url",
      "https://example.invalid/unexpected.git",
    );
    expect((await verifyOperationalIntegrity(cwd, baseline)).verdict).toBe(
      "changed",
    );
    await git("config", "--unset", "remote.origin.url");
    await rename(cwd, join(root, "moved"));
    await symlink(join(root, "moved"), cwd, "dir");
    expect((await verifyOperationalIntegrity(cwd, baseline)).verdict).toBe(
      "indeterminate",
    );
    await expect(
      captureOperationalBaseline(cwd, "worktree"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it.each([
    "tracked",
    "staged",
    "untracked",
    "ignored",
    "committed",
    "commit_and_revert",
    "commit_and_reset",
    "rename",
  ])("detects %s without destroying bytes", async (change) => {
    const baseline = await captureOperationalGeneration(
      cwd,
      await captureOperationalBaseline(cwd, "worktree"),
      [],
    );

    if (change === "ignored")
      await writeFile(join(cwd, "ignored.bin"), Buffer.from([0, 255, 1, 2]));
    else if (change === "untracked")
      await writeFile(join(cwd, "new.ts"), "unexpected");
    else if (change === "rename") await git("mv", "source.ts", "renamed.ts");
    else {
      await writeFile(join(cwd, "source.ts"), "export const value = 2;\n");
      if (
        [
          "staged",
          "committed",
          "commit_and_revert",
          "commit_and_reset",
        ].includes(change)
      )
        await git("add", ".");
      if (
        ["committed", "commit_and_revert", "commit_and_reset"].includes(change)
      )
        await git("commit", "-qm", "unexpected");
      if (change === "commit_and_revert")
        await git("revert", "--no-edit", "HEAD");
      if (change === "commit_and_reset") await git("reset", "--hard", "HEAD~1");
    }
    const verdict = await verifyOperationalIntegrity(cwd, baseline);

    expect(verdict.verdict).toBe("changed");
    if (change === "ignored")
      expect(await readFile(join(cwd, "ignored.bin"))).toEqual(
        Buffer.from([0, 255, 1, 2]),
      );
  });

  it("IT-EDGE-OPL-04 refuses untrusted generation changes, symlink traversal, missing evidence and probe limits", async () => {
    const baseline = await captureOperationalBaseline(cwd, "worktree");

    await writeFile(join(cwd, "source.ts"), "unrelated source edit");
    await expect(
      captureOperationalGeneration(cwd, baseline, [".claude/skills/scan"]),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "operational_materialization_conflict" },
    });
    expect((await verifyOperationalIntegrity(cwd, null)).verdict).toBe(
      "indeterminate",
    );
    for (const [limits, limitAxis, maximum] of [
      [{ maxBytes: 1 }, "bytes", 1],
      [{ maxEntries: 1 }, "entries", 1],
      [{ maxProbeMs: 0 }, "time", 0],
    ] as const)
      await expect(
        captureOperationalBaseline(cwd, "worktree", limits),
      ).rejects.toMatchObject({
        details: {
          reason: "operational_integrity_limit",
          limitAxis,
          maximum,
          observed: expect.any(Number),
          observedBytes: expect.any(Number),
          observedEntries: expect.any(Number),
          elapsedMs: expect.any(Number),
        },
      });
    await symlink(root, join(cwd, "external"));
    const snapshot = await captureOperationalBaseline(cwd, "worktree");

    expect(
      snapshot.source.find((entry) => entry.path === "external")?.type,
    ).toBe("symlink");
    expect(
      snapshot.source.some((entry) => entry.path.startsWith("external/")),
    ).toBe(false);
  });

  it("identifies the worktree configuration byte cap and still refuses final integrity", async () => {
    const ready = await captureOperationalGeneration(
      cwd,
      await captureOperationalBaseline(cwd, "worktree"),
      [],
    );

    await writeFile(
      join(cwd, ".git", "config.worktree"),
      "x".repeat(1024 * 1024 + 1),
    );
    await expect(
      captureOperationalBaseline(cwd, "worktree"),
    ).rejects.toMatchObject({
      details: {
        reason: "operational_integrity_limit",
        limitAxis: "worktree_config_bytes",
        observed: 1024 * 1024 + 1,
        maximum: 1024 * 1024,
      },
    });
    expect(await verifyOperationalIntegrity(cwd, ready)).toMatchObject({
      verdict: "indeterminate",
      reasonCodes: ["operational_integrity_limit"],
    });
  });

  it("accepts only server-proven parallel allocation or disposal, never a changed foreign ref", async () => {
    const baseline = await captureOperationalGeneration(
      cwd,
      await captureOperationalBaseline(cwd, "worktree"),
      [],
    );

    await git("branch", "parallel-operation");
    const ref = "refs/heads/parallel-operation";

    expect((await verifyOperationalIntegrity(cwd, baseline)).verdict).toBe(
      "indeterminate",
    );
    expect(
      (
        await verifyOperationalIntegrity(cwd, baseline, [
          { kind: "allocated", ref, sha: baseline.head! },
        ])
      ).verdict,
    ).toBe("clean");
    await writeFile(join(cwd, "source.ts"), "unexpected");
    await git("add", ".");
    await git("commit", "-qm", "changed");
    await git("branch", "-f", "parallel-operation", "HEAD");
    expect(
      (
        await verifyOperationalIntegrity(cwd, baseline, [
          { kind: "allocated", ref, sha: baseline.head! },
        ])
      ).verdict,
    ).not.toBe("clean");
  });

  it("marks shared-repository conflicts indeterminate and validates plain owned directories", async () => {
    const baseline = await captureOperationalGeneration(
      cwd,
      await captureOperationalBaseline(cwd, "shared_repository"),
      [],
    );

    await writeFile(join(cwd, "source.ts"), "concurrent parent edit");
    expect((await verifyOperationalIntegrity(cwd, baseline)).verdict).toBe(
      "indeterminate",
    );
    const plain = join(root, "plain");

    await mkdir(plain);
    const plainBaseline = await captureOperationalGeneration(
      plain,
      await captureOperationalBaseline(plain, "plain_directory"),
      [],
    );

    expect(
      (await verifyOperationalIntegrity(plain, plainBaseline)).verdict,
    ).toBe("clean");
    await mkdir(join(plain, ".git"));
    await writeFile(
      join(plain, ".git", "config"),
      "unexpected repository state",
    );
    expect(
      (await verifyOperationalIntegrity(plain, plainBaseline)).verdict,
    ).toBe("changed");
  });
});
