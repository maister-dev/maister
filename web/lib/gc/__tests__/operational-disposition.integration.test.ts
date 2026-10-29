import type { Db } from "@/lib/execution-host/db";
import type { ReserveRuntimeObjectPayload } from "@/lib/execution-host/contracts";

import { mkdtemp, mkdir, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  prepareAgentRunFinalization,
  finalizeAgentRun,
} from "@/lib/agents/finalization";
import {
  operationalWorkspace,
  inspectOperationalRun,
} from "@/lib/agents/operational-context";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
} from "@/lib/agents/operational-integrity";
import { operationalAgentRuntimePath } from "@/lib/agents/workspace-paths";
import {
  executionAssignments,
  executionCommands,
  executionRuntimeObjects,
  runs,
  workspaces,
} from "@/lib/db/schema";
import {
  disposeOperationalRun,
  sweepOperationalDispositions,
} from "@/lib/gc/operational-disposition";
import { runWorkspaceGcSweep } from "@/lib/gc/workspace-gc";
import { runPlainAgentDirectoryGcSweep } from "@/lib/gc/plain-agent-directory-gc";
import { runEphemeralAgentGcSweep } from "@/lib/gc/ephemeral-agent-gc";
import { runAgentMaterializationCleanupSweep } from "@/lib/gc/agent-materialization-gc";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { reconcileAgentPermissionResume } from "@/lib/agents/permission-resume";
import { sweepExpiredRuntimeObjects } from "@/lib/execution-host/runtime-object-retention";
import { addDetachedWorktree } from "@/lib/worktree";
import { gcAgeDays } from "@/lib/instance-config";
import { readRuntimeObjectContent } from "@/lib/execution-host/runtime-objects";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { git } from "@/test-support/git-fixture";
import { operationalSuccessFixture } from "@/test-support/operational-agent";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let database: StartedPostgresTestDb;
let db: Db;
let root: string;
let seam: Awaited<ReturnType<typeof fakeExecutionHosts>>;
const previousRoot = process.env.MAISTER_WORKTREES_ROOT;
const previousArchivePush = process.env.MAISTER_GC_ARCHIVE_PUSH;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "operational_disposition",
  });
  db = database.db;
  root = await mkdtemp(path.join(tmpdir(), "operational-disposition-"));
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  seam = await fakeExecutionHosts(db);
}, 180_000);
afterEach(async () => {
  if (previousArchivePush === undefined)
    delete process.env.MAISTER_GC_ARCHIVE_PUSH;
  else process.env.MAISTER_GC_ARCHIVE_PUSH = previousArchivePush;
  await database.pool.query("DELETE FROM execution_commands");
  await database.pool.query("DELETE FROM runs");
  await database.pool.query("DELETE FROM projects");
});
afterAll(async () => {
  if (previousRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousRoot;
  await database?.stop();
  await rm(root, { recursive: true, force: true });
});

async function seed(
  workspace: "none" | "repo_read" | "worktree" = "worktree",
  workspaceRef?: "trigger",
) {
  const runId = await seedAgentRun(db, {
    runtimeRoot: root,
    workspace,
    operational: true,
    resultContract: null,
    definition: `---\nname: Operation\ndescription: d\nkind: operational\ncompletion: {contract: operational_v1}\nworkspace: ${workspace}\n${workspaceRef ? `workspace_ref: ${workspaceRef}\n` : ""}mode: session\nplatform_mcp: false\ntriggers: [manual]\nrisk_tier: standard\n---\nPerform operation.\n`,
  });
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const context = await operationalWorkspace(db, run);

  if (context.resourceKind === "ephemeral_checkout")
    await addDetachedWorktree({
      projectRepoPath: context.repoPath,
      worktreePath: context.cwd,
      committish: "HEAD",
    });
  else await mkdir(context.cwd, { recursive: true });
  const baseline = await captureOperationalGeneration(
    context.cwd,
    await captureOperationalBaseline(context.cwd, context.resourceKind),
    [],
  );

  await db
    .update(runs)
    .set({ operationalIntegrityBaseline: baseline })
    .where(eq(runs.id, runId));
  const runtime = operationalAgentRuntimePath(context.projectSlug, runId);

  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, "cache"), "native cache");

  return { runId, context, runtime };
}
async function row(runId: string) {
  return (await db.select().from(runs).where(eq(runs.id, runId)))[0];
}
const output = `\`\`\`json maister:output\n${JSON.stringify(operationalSuccessFixture())}\n\`\`\``;

describe("operational disposition through existing lifecycle owners", () => {
  it.each(["none", "worktree"] as const)(
    "IT-OPL-05 disposes successful %s execution and its native home after commit",
    async (workspace) => {
      const seeded = await seed(workspace);

      await finalizeAgentRun(seeded.runId, "Done", { db, finalText: output });
      expect((await row(seeded.runId)).status).toBe("Done");
      await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(seeded.runtime)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await row(seeded.runId)).operationalCleanup).toMatchObject({
        state: "released",
        removedAt: expect.any(String),
        releasedAt: expect.any(String),
      });
      expect(
        await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
      ).toBe("skipped");
    },
  );

  it.each([undefined, "trigger"] as const)(
    "IT-OPL-06 disposes repo_read resource (%s) without removing its parent",
    async (ref) => {
      const seeded = await seed("repo_read", ref);
      const before = await git(seeded.context.repoPath, "rev-parse", "HEAD");

      await finalizeAgentRun(seeded.runId, "Done", { db, finalText: output });
      expect((await row(seeded.runId)).status).toBe("Done");
      expect((await row(seeded.runId)).operationalCleanup?.state).toBe(
        "released",
      );
      expect((await lstat(seeded.context.repoPath)).isDirectory()).toBe(true);
      expect(await git(seeded.context.repoPath, "rev-parse", "HEAD")).toBe(
        before,
      );
      if (ref)
        await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );

  it("IT-OPL-07 IT-EDGE-OPL-07 preserves ignored binary bytes before deleting unexpected source, without minting an assignment", async () => {
    const seeded = await seed();
    const remote = path.join(root, `diagnostic-remote-${seeded.runId}.git`);

    await git(root, "init", "--bare", remote);
    await git(seeded.context.repoPath, "remote", "add", "origin", remote);
    process.env.MAISTER_GC_ARCHIVE_PUSH = "true";
    const bytes = Buffer.from([0, 255, 128, 1, 2, 0]);

    await writeFile(
      path.join(seeded.context.cwd, ".gitignore"),
      "ignored.bin\n",
    );
    await writeFile(path.join(seeded.context.cwd, "ignored.bin"), bytes);
    await finalizeAgentRun(seeded.runId, "Done", { db, finalText: output });
    const current = await row(seeded.runId);

    expect(current).toMatchObject({
      status: "Failed",
      operationalTerminal: { integrity: "changed", successful: false },
      operationalCleanup: { state: "released" },
    });
    await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const assignments = await db
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.runId, seeded.runId));

    expect(assignments).toHaveLength(1);
    expect(assignments[0].state).toBe("released");
    const ids = current.operationalCleanup!.evidenceIds;

    expect(ids.length).toBeGreaterThan(1);
    const objects = await db
      .select()
      .from(executionRuntimeObjects)
      .where(eq(executionRuntimeObjects.runId, seeded.runId));

    expect(
      objects
        .filter((object) => ids.includes(object.id))
        .every((object) => object.state === "available"),
    ).toBe(true);
    const records: Array<{ path?: string; bytes?: string }> = [];

    for (const objectId of ids.slice(1)) {
      const { content } = await readRuntimeObjectContent({
        db,
        runId: seeded.runId,
        objectId,
        transportForHost: async () => seam.fake.transport,
      });

      records.push(
        ...new TextDecoder()
          .decode(content.bytes)
          .trim()
          .split("\n")
          .map((line: string) => JSON.parse(line)),
      );
    }
    expect(
      Buffer.concat(
        records
          .filter((record) => record.path === "ignored.bin" && record.bytes)
          .map((record) => Buffer.from(record.bytes!, "base64")),
      ),
    ).toEqual(bytes);
    await sweepExpiredRuntimeObjects({
      db,
      hosts: seam.hosts,
      now: new Date(current.endedAt!.getTime() + 60_000),
    });
    expect(
      (
        await db
          .select()
          .from(executionRuntimeObjects)
          .where(eq(executionRuntimeObjects.runId, seeded.runId))
      )
        .filter((object) => ids.includes(object.id))
        .every((object) => object.state === "available"),
    ).toBe(true);
    const expired = await sweepExpiredRuntimeObjects({
      db,
      hosts: seam.hosts,
      now: new Date(
        current.endedAt!.getTime() + (gcAgeDays() + 1) * 86_400_000,
      ),
    });

    expect(expired.scanned).toBeGreaterThan(0);
    expect(expired.failed).toBe(0);
    expect(await git(remote, "for-each-ref", "--format=%(refname)")).toBe("");
  });

  it("IT-OPL-05 legacy cleaners cannot bypass crash hold or retry exhaustion", async () => {
    const seeded = await seed();

    await finalizeAgentRun(seeded.runId, "Crashed", { db });
    expect((await row(seeded.runId)).operationalCleanup?.state).toBe(
      "retained",
    );
    await runWorkspaceGcSweep({ db });
    await runPlainAgentDirectoryGcSweep();
    await runEphemeralAgentGcSweep({ db });
    await runAgentMaterializationCleanupSweep({ db });
    expect((await lstat(seeded.context.cwd)).isDirectory()).toBe(true);
    expect(
      await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
    ).toBe("skipped");
  });

  it("IT-OPL-03 recognizes a concurrent operation's recorded local archive without trusting an unrecorded ref", async () => {
    const live = await seed();
    const sibling = await seed();
    const retained = await prepareAgentRunFinalization(
      sibling.runId,
      "Crashed",
      { db },
    );

    await db.transaction((tx) => retained.apply(tx));
    const archive = `archive/${sibling.runId}`;
    const source = await row(live.runId);
    const sha = source.operationalIntegrityBaseline!.head!;

    await git(live.context.repoPath, "branch", archive, sha);
    expect((await inspectOperationalRun(db, source)).verdict).toBe(
      "indeterminate",
    );
    await db
      .update(runs)
      .set({ projectId: source.projectId })
      .where(eq(runs.id, sibling.runId));
    await db
      .update(workspaces)
      .set({
        projectId: source.projectId!,
        archivedBranch: archive,
        archivedCommit: sha,
        archivedAt: new Date(),
        preservationOutcome: "snapshot_created",
      })
      .where(eq(workspaces.runId, sibling.runId));
    expect((await inspectOperationalRun(db, source)).verdict).toBe("clean");
    const forged = await git(
      live.context.repoPath,
      "-c",
      "user.name=Operation",
      "-c",
      "user.email=operation@example.test",
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-m",
      "unrecorded archive replacement",
    );

    await git(
      live.context.repoPath,
      "update-ref",
      `refs/heads/${archive}`,
      forged.trim(),
    );
    expect((await inspectOperationalRun(db, source)).verdict).toBe(
      "indeterminate",
    );
  });

  it("IT-OPL-07 released assignments admit only bounded run-owned diagnostic evidence while preserving", async () => {
    const seeded = await seed();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    const current = await row(seeded.runId);

    await db
      .update(runs)
      .set({
        operationalCleanup: {
          ...current.operationalCleanup!,
          state: "preserving",
        },
      })
      .where(eq(runs.id, seeded.runId));
    const client = await seam.hosts.forAssignment({
      id: current.executionAssignmentId!,
    });
    const previousReservations = seam.fake.callsOf(
      "reserveRuntimeObject",
    ).length;
    const reservation = {
      kind: "diagnostic",
      logicalName: "operational-diagnosis-bounded",
      mimeType: "application/x-ndjson",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      generation: 1,
      retentionClass: "run",
      expiresAt: null,
    } satisfies Omit<ReserveRuntimeObjectPayload, "objectId">;

    for (const change of [
      { kind: "generated_artifact" as const },
      { logicalName: "ordinary-output" },
      {
        retentionClass: "ephemeral" as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { sizeBytes: 25 * 1024 * 1024 + 1 },
    ]) {
      await expect(
        client.reserveRuntimeObject({
          ...reservation,
          ...change,
          objectId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "assignment_fenced" },
      });
    }
    const admitted = await client.reserveRuntimeObject({
      ...reservation,
      objectId: crypto.randomUUID(),
    });

    expect(admitted.state).toBe("pending");
    expect(seam.fake.callsOf("reserveRuntimeObject")).toHaveLength(
      previousReservations + 1,
    );
    await db
      .update(runs)
      .set({
        operationalCleanup: { ...current.operationalCleanup!, state: "armed" },
      })
      .where(eq(runs.id, seeded.runId));
    await expect(
      client.reserveRuntimeObject({
        ...reservation,
        objectId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ details: { reason: "assignment_fenced" } });
  });

  it("IT-OPL-06 an interrupted parallel reissue with conflicting source generations becomes actionable without replay", async () => {
    const seeded = await seed();

    await database.pool.query(
      "UPDATE runs SET status='NeedsInputIdle' WHERE id=$1",
      [seeded.runId],
    );
    for (const ordinal of [1, 2]) {
      await database.pool.query(
        `INSERT INTO hitl_requests(id,run_id,step_id,kind,schema,prompt) VALUES ($1,$2,'agent','permission',$3::jsonb,'Retained parallel permission')`,
        [
          `mixed-permission-${seeded.runId}-${ordinal}`,
          seeded.runId,
          JSON.stringify({
            requestId: `request-${ordinal}`,
            supervisorSessionId: `session-${ordinal}`,
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
            toolCall: { toolCallId: `tool-${ordinal}`, title: "Read provider" },
            agentPrompt: {
              version: 1,
              commandId: `command-${ordinal}`,
              turnId: `turn-${ordinal}`,
              promptOrdinal: ordinal,
              assignmentId: `assignment-${ordinal}`,
              incarnationId: `incarnation-${ordinal}`,
            },
          }),
        ],
      );
    }
    await reconcileAgentPermissionResume(db, seeded.runId, seam.fake.transport);
    expect(await row(seeded.runId)).toMatchObject({
      status: "Crashed",
      operationalTerminal: { successful: false, cause: "operational_crashed" },
      operationalCleanup: { state: "retained" },
    });
    expect(seam.fake.callsOf("deliverInput")).toHaveLength(0);
    expect((await lstat(seeded.context.cwd)).isDirectory()).toBe(true);
  });

  it("IT-EDGE-OPL-06 fences a second cleaner and refuses stale completion after lease expiry", async () => {
    const seeded = await seed();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = disposeOperationalRun(seeded.runId, {
      db,
      hosts: seam.hosts,
      preserve: async () => {
        enter();
        await blocked;

        return { ok: true, preservationOutcome: "not_needed" };
      },
    });

    await entered;
    expect(
      await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
    ).toBe("skipped");
    expect((await lstat(seeded.context.cwd)).isDirectory()).toBe(true);
    await db
      .update(workspaces)
      .set({ lifecycleOperationLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(workspaces.runId, seeded.runId));
    expect(
      await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
    ).toBe("released");
    resume();
    expect(await first).toBe("deferred");
    expect((await row(seeded.runId)).operationalCleanup?.state).toBe(
      "released",
    );
  });

  it("IT-EDGE-OPL-05 converges after local removal precedes its cleanup receipt without recreating source", async () => {
    const seeded = await seed();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    await database.pool.query(
      `CREATE FUNCTION refuse_operational_removed_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operational_cleanup->>'state' = 'removed' THEN RAISE EXCEPTION 'fixture receipt boundary'; END IF; RETURN NEW; END $$`,
    );
    await database.pool.query(
      "CREATE TRIGGER refuse_operational_removed_receipt BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION refuse_operational_removed_receipt()",
    );
    try {
      expect(
        await disposeOperationalRun(seeded.runId, { db, hosts: seam.hosts }),
      ).toBe("deferred");
      await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await row(seeded.runId)).operationalCleanup).toMatchObject({
        state: "retry",
        removedAt: null,
      });
    } finally {
      await database.pool.query(
        "DROP TRIGGER refuse_operational_removed_receipt ON runs",
      );
      await database.pool.query(
        "DROP FUNCTION refuse_operational_removed_receipt()",
      );
    }
    const retry = await row(seeded.runId);

    expect(
      await disposeOperationalRun(seeded.runId, {
        db,
        hosts: seam.hosts,
        now: new Date(retry.operationalCleanup!.dueAt!),
      }),
    ).toBe("released");
    await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await row(seeded.runId)).operationalCleanup?.removedAt,
    ).not.toBeNull();
  });

  it("IT-EDGE-OPL-05 host release acknowledgement loss converges without another assignment or recreated files", async () => {
    const seeded = await seed();
    const initial = await row(seeded.runId);
    const client = await seam.hosts.forAssignment({
      id: initial.executionAssignmentId!,
    });

    await client.ensureWorkspace();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    seam.fake.loseResponseOnce("releaseWorkspace");
    const first = await disposeOperationalRun(seeded.runId, {
      db,
      hosts: seam.hosts,
    });

    if (first === "deferred") {
      const recovery = await recoverExecutionCommands({
        db,
        transport: seam.fake.transport,
        graceMs: 0,
      });

      expect(recovery.errors).toEqual([]);
      const retry = (await row(seeded.runId)).operationalCleanup!;

      expect(retry.removedAt).not.toBeNull();
      await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await disposeOperationalRun(seeded.runId, {
          db,
          hosts: seam.hosts,
          now: new Date(retry.dueAt!),
        }),
      ).toBe("released");
    } else expect(first).toBe("released");
    expect((await row(seeded.runId)).operationalCleanup?.state).toBe(
      "released",
    );
    expect(
      await db
        .select()
        .from(executionAssignments)
        .where(eq(executionAssignments.runId, seeded.runId)),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.runId, seeded.runId))
      ).filter((command) => command.kind === "workspace.adopt"),
    ).toHaveLength(1);
    await expect(lstat(seeded.context.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("IT-OPL-08 rotates a bounded disposition cursor past a poison run", async () => {
    const template = await seed("none");
    const prepared = await prepareAgentRunFinalization(template.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    const original = await row(template.runId);

    await db.delete(runs).where(eq(runs.id, template.runId));
    const inserts = Array.from({ length: 103 }, (_, index) => ({
      id: `zz-fair-${String(index).padStart(4, "0")}`,
      projectId: original.projectId,
      runKind: "agent" as const,
      agentKind: "operational" as const,
      agentWorkspace: "none" as const,
      status: "Done",
      flowVersion: "agent",
      endedAt: new Date(),
      resultContract: original.resultContract,
      operationalTerminal: {
        ...original.operationalTerminal!,
        status: "Abandoned" as const,
        effectiveOutcome: "cancelled" as const,
        successful: false,
        validation: "unchecked" as const,
        resultRevision: null,
      },
      operationalCleanup: {
        ...original.operationalCleanup!,
        workspace: "none" as const,
        resourceKind: "plain_directory" as const,
      },
    }));

    // Missing physical resources are safe to dispose; the first corrupted
    // launch digest must consume its own bounded attempt and not own the page.
    await db.insert(runs).values(
      inserts.map((item, index) => ({
        ...item,
        status: "Abandoned" as const,
        resultContract:
          index === 0
            ? { ...item.resultContract!, sha256: "0".repeat(64) }
            : item.resultContract,
      })),
    );
    const first = await sweepOperationalDispositions({ db, hosts: seam.hosts });
    const second = await sweepOperationalDispositions({
      db,
      hosts: seam.hosts,
    });

    expect(first.scanned).toBe(100);
    expect(second.scanned).toBe(3);
    expect((await row("zz-fair-0000")).operationalCleanup).toMatchObject({
      state: "retry",
      attempts: 1,
    });
    expect((await row("zz-fair-0102")).operationalCleanup?.state).toBe(
      "released",
    );
  });

  it("IT-EDGE-OPL-05 preserves before removal, bounds retries and leaves business completion unchanged", async () => {
    const seeded = await seed();
    const prepared = await prepareAgentRunFinalization(seeded.runId, "Done", {
      db,
      finalText: output,
    });

    await db.transaction((tx) => prepared.apply(tx));
    let now = new Date();

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(
        await disposeOperationalRun(seeded.runId, {
          db,
          hosts: seam.hosts,
          now,
          preserve: async () => ({
            ok: false,
            failureReason: "workspace_preservation_failed",
          }),
        }),
      ).toBe("deferred");
      const current = await row(seeded.runId);

      expect(current.status).toBe("Done");
      expect(current.operationalCleanup).toMatchObject({
        attempts: attempt,
        state: attempt === 5 ? "exhausted" : "retry",
        errorCode: "workspace_preservation_failed",
      });
      expect((await lstat(seeded.context.cwd)).isDirectory()).toBe(true);
      if (current.operationalCleanup?.dueAt)
        now = new Date(current.operationalCleanup.dueAt);
    }
    expect(
      await disposeOperationalRun(seeded.runId, {
        db,
        hosts: seam.hosts,
        now: new Date(now.getTime() + 86_400_000),
      }),
    ).toBe("skipped");
    expect(
      (
        await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.runId, seeded.runId))
      )[0].removedAt,
    ).toBeNull();
    expect(
      (await sweepOperationalDispositions({ db, hosts: seam.hosts, now }))
        .released,
    ).toBe(0);
  });
});
