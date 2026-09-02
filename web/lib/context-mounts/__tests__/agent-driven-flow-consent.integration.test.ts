/**
 * ADR-157 D11 — consent has exactly TWO forms (the launching user's
 * `readRepoFiles`, or the attach-time admin action on
 * `agent_project_links.context_repos`), and an AGENT-DRIVEN FLOW RUN has
 * neither: `launchAgentDrivenFlowRun` launches with `actorUserId: null`, and the
 * node's `context_repos` came from the flow package rather than from any admin's
 * attach confirmation. Before this was named, such a run reached
 * `authorizeLaunchingUser` with no user and died on a message about an
 * "authenticated launching user" that no operator could act on. It is now
 * refused explicitly — and, critically, ONLY when mounts are actually declared
 * and enabled, so an agent-driven flow otherwise keeps working.
 */
import type { ExecutionHosts } from "@/lib/execution-host";
import type { FakeCall } from "@/test-support/fake-execution-host";
import type { ContextMountSnapshot } from "@/lib/context-mounts/types";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { prepareContextMounts } from "@/lib/context-mounts/launch";
import { isMaisterError } from "@/lib/errors";
import { runFlow } from "@/lib/flows/runner";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import { commitFile, listWorktrees } from "@/lib/worktree";
import {
  schema,
  seedGraphRun,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
  closeDb: async () => undefined,
}));

const execFileAsync = promisify(execFile);

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

const createdPaths: string[] = [];
const originalRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const originalKillSwitch = process.env.MAISTER_CONTEXT_MOUNT_ENABLED;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_driven_mount_consent_test",
  });
  db = testDatabase.db;
}, 240_000);

afterEach(() => {
  if (originalRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = originalRuntimeRoot;
  if (originalKillSwitch === undefined) {
    delete process.env.MAISTER_CONTEXT_MOUNT_ENABLED;
  } else {
    process.env.MAISTER_CONTEXT_MOUNT_ENABLED = originalKillSwitch;
  }
});

afterAll(async () => {
  await Promise.all(
    createdPaths.map((p) => rm(p, { recursive: true, force: true })),
  );
  await testDatabase?.stop();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout;
}

type SiblingRepo = { slug: string; projectId: string; repoPath: string };

async function createSiblingProject(): Promise<SiblingRepo> {
  const repoPath = await mkdtemp(join(tmpdir(), "maister-adf-sibling-"));

  createdPaths.push(repoPath);
  await git(repoPath, "init", "-q", "-b", "main");
  await writeFile(join(repoPath, "CONTRACT.md"), "CONTRACT-V1\n");
  await commitFile({
    repo: repoPath,
    file: "CONTRACT.md",
    message: "contract",
  });

  const projectId = randomUUID();
  const slug = `sib-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    taskKey: `SIB${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    id: projectId,
    slug,
    name: "Sibling",
    repoPath,
    mainBranch: "main",
    maisterYamlPath: "/tmp/sibling.yaml",
  });

  return { slug, projectId, repoPath };
}

async function createAdminUser(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.users).values({
    id,
    email: `admin-${id.slice(0, 8)}@maister.local`,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  });

  return id;
}

// The driving agent + the package chain the flow-bound persona resolver walks
// (agents row enabled, install trusted + Installed, project attachment). Seeded
// BEFORE the run because runs.agent_id is an FK to agents.id; the attachment is
// added once seedGraphRun has minted the project.
async function createDrivingAgent(): Promise<{
  agentId: string;
  packageInstallId: string;
  packageName: string;
}> {
  const packageRoot = await mkdtemp(join(tmpdir(), "maister-adf-pkg-"));

  createdPaths.push(packageRoot);
  await mkdir(join(packageRoot, "maister-agents"), { recursive: true });
  await writeFile(
    join(packageRoot, "maister-agents", "driver.md"),
    `---
name: Driver
description: the driving persona
workspace: worktree
mode: session
triggers:
  - manual
risk_tier: read_only
---
You are the driving persona.
`,
    "utf8",
  );

  const packageInstallId = randomUUID();
  // `resolveEffectiveAgentDefinition` splits the qualified id and looks the
  // package up by NAME on the project's attachments, so the id prefix and the
  // package name must be the same string — both unique per test because this
  // file never truncates between cases.
  const packageName = `adf-pkg-${packageInstallId.slice(0, 8)}`;
  const agentId = `${packageName}:driver`;

  await db.insert(schema.packageInstalls).values({
    id: packageInstallId,
    sourceUrl: "github.com/acme/adf-pkg",
    name: packageName,
    versionLabel: "v1.0.0",
    resolvedRevision: `rev-${packageInstallId.slice(0, 8)}`,
    manifest: {},
    manifestDigest: "digest",
    installedPath: packageRoot,
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
  await db.insert(schema.agents).values({
    id: agentId,
    packageName,
    versionLabel: "v1.0.0",
    origin: "git",
    name: "Driver",
    description: "d",
    workspace: "worktree",
    mode: "session",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath: join(packageRoot, "maister-agents", "driver.md"),
  });

  return { agentId, packageInstallId, packageName };
}

function flowWithMounts(siblingSlug: string) {
  return {
    schemaVersion: 1,
    name: "ctx",
    // ADR-157 floor: settings.context_repos requires engine_min >= 3.4.0.
    compat: { engine_min: "3.4.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "read the sibling contract" },
        transitions: { success: "done" },
        settings: { context_repos: [{ project: siblingSlug }] },
      },
    ],
  };
}

function flowWithoutMounts() {
  return {
    schemaVersion: 1,
    name: "ctx",
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "do the work" },
        transitions: { success: "done" },
      },
    ],
  };
}

// ADR-164: a fake execution host (clean end-turn) plus spies on every
// `workspace.adopt` and `session.create` payload the runner sends. The
// launch's context-mount snapshot rides the ADOPT payload (D7) — the session
// body is the path-less handle form.
async function makeSupervisorSpy(runId: string): Promise<{
  hosts: ExecutionHosts;
  createSpy: ReturnType<typeof vi.fn>;
  adoptSpy: ReturnType<typeof vi.fn>;
}> {
  const createSpy = vi.fn();
  const adoptSpy = vi.fn();
  const { hosts, fake } = await fakeGraphHosts(db, runId);

  fake.onCall("createSession", (call: FakeCall) => {
    createSpy(call.envelope?.payload);
  });
  fake.onCall("adoptWorkspace", (call: FakeCall) => {
    adoptSpy(call.envelope?.payload);
  });

  return { hosts, createSpy, adoptSpy };
}

async function seedRun(args: {
  manifest: unknown;
  agentId?: string;
  packageInstallId?: string;
  packageName?: string;
  createdByUserId?: string;
}): Promise<SeededGraphRun> {
  const seeded = await seedGraphRun(db, args.manifest, {
    flowRefId: "ctx",
    flowRevision: true,
    run: {
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.createdByUserId
        ? { createdByUserId: args.createdByUserId }
        : {}),
    },
  });

  if (args.packageInstallId && args.packageName) {
    await db.insert(schema.projectPackageAttachments).values({
      id: randomUUID(),
      projectId: seeded.projectId,
      packageInstallId: args.packageInstallId,
      packageName: args.packageName,
    });
  }

  createdPaths.push(seeded.runtimeRoot, seeded.worktreePath);
  // contextMountPath() reads runtimeRoot() from the env, so pin it to the same
  // root runFlow is handed.
  process.env.MAISTER_RUNTIME_ROOT = seeded.runtimeRoot;

  return seeded;
}

async function loadSnapshot(runId: string): Promise<ContextMountSnapshot[]> {
  const rows = (await db
    .select({ contextMounts: schema.runs.contextMounts })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<{
    contextMounts: ContextMountSnapshot[] | null;
  }>;

  return rows[0]?.contextMounts ?? [];
}

async function implementAttempt(
  runId: string,
): Promise<{ status: string; errorCode: string | null } | undefined> {
  const rows = (await db
    .select({
      nodeId: schema.nodeAttempts.nodeId,
      status: schema.nodeAttempts.status,
      errorCode: schema.nodeAttempts.errorCode,
    })
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as Array<{
    nodeId: string;
    status: string;
    errorCode: string | null;
  }>;

  return rows.find((r) => r.nodeId === "implement");
}

// A sibling with only its own root worktree registered ⇒ nothing was mounted.
async function siblingWorktreeCount(repoPath: string): Promise<number> {
  return (await listWorktrees(repoPath)).length;
}

describe("ADR-157 D11 — an agent-driven flow run has no context-mount consent form", () => {
  it("refuses the mount-declaring node with PRECONDITION before any session or checkout", async () => {
    const sibling = await createSiblingProject();
    const { agentId, packageInstallId, packageName } =
      await createDrivingAgent();
    const seeded = await seedRun({
      manifest: flowWithMounts(sibling.slug),
      agentId,
      packageInstallId,
      packageName,
    });
    const api = await makeSupervisorSpy(seeded.runId);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api.hosts,
    });

    const attempt = await implementAttempt(seeded.runId);

    expect(attempt?.status).toBe("Failed");
    expect(attempt?.errorCode).toBe("PRECONDITION");

    // Refused BEFORE the ACP session and BEFORE any git side-effect: no mount was
    // snapshotted and the sibling repo gained no worktree registration.
    //
    // The failure CODE alone does not discriminate this fix (the pre-fix path
    // also died PRECONDITION here, just with an unactionable "requires an
    // authenticated launching user"). What these three assertions pin is the
    // WRONG fix: quietly treating the driving agent's attachment as consent
    // would materialize the mount and hand it to the session — the
    // authorization laundering D11 exists to prevent. The operator-facing text
    // is pinned by the next case.
    expect(await loadSnapshot(seeded.runId)).toHaveLength(0);
    expect(api.createSpy).not.toHaveBeenCalled();
    expect(await siblingWorktreeCount(sibling.repoPath)).toBe(1);
  }, 120_000);

  it("names the unsupported combination and both supported alternatives in the refusal", async () => {
    const sibling = await createSiblingProject();
    const agentId = "adf-pkg:driver";

    // Asserted at the choke point: the node-attempt row records only the error
    // CODE, so the operator-facing text is only observable here.
    const err = await prepareContextMounts({
      db,
      runId: randomUUID(),
      consumingProjectSlug: "consumer",
      decls: [{ project: sibling.slug }],
      consent: { kind: "agent-driven-flow", agentId },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isMaisterError(err) && err.code).toBe("PRECONDITION");

    const message = (err as Error).message;

    expect(message).toContain("agent-driven flow run");
    expect(message).toContain(agentId);
    expect(message).toContain(sibling.slug);
    // Alternative 1: declare the mounts on the agent's project attachment.
    expect(message).toContain("attachment");
    // Alternative 2: launch the flow as a user holding the read grant.
    expect(message).toContain("readRepoFiles");
  }, 60_000);

  it("an agent-driven flow run that declares NO context_repos still runs the node", async () => {
    const { agentId, packageInstallId, packageName } =
      await createDrivingAgent();
    const seeded = await seedRun({
      manifest: flowWithoutMounts(),
      agentId,
      packageInstallId,
      packageName,
    });
    const api = await makeSupervisorSpy(seeded.runId);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api.hosts,
    });

    // The regression guard: the refusal is keyed on DECLARED mounts, never on
    // "this run is agent-driven".
    expect(await implementAttempt(seeded.runId)).toMatchObject({
      status: "Succeeded",
      errorCode: null,
    });
    expect(api.createSpy).toHaveBeenCalled();
    expect(await loadSnapshot(seeded.runId)).toHaveLength(0);
  }, 120_000);

  it("kill-switch off: an agent-driven flow WITH declarations launches and mounts nothing", async () => {
    const sibling = await createSiblingProject();
    const { agentId, packageInstallId, packageName } =
      await createDrivingAgent();
    const seeded = await seedRun({
      manifest: flowWithMounts(sibling.slug),
      agentId,
      packageInstallId,
      packageName,
    });

    process.env.MAISTER_CONTEXT_MOUNT_ENABLED = "false";

    const api = await makeSupervisorSpy(seeded.runId);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api.hosts,
    });

    // With mounts disabled there is nothing to consent to, so the refusal must
    // NOT fire — the ordering inside prepareContextMounts is what guarantees it.
    expect(await implementAttempt(seeded.runId)).toMatchObject({
      status: "Succeeded",
      errorCode: null,
    });
    expect(await loadSnapshot(seeded.runId)).toHaveLength(0);
    expect(await siblingWorktreeCount(sibling.repoPath)).toBe(1);

    const createArg = api.adoptSpy.mock.calls[0][0] as {
      contextMounts?: ContextMountSnapshot[];
    };

    expect(createArg.contextMounts ?? []).toHaveLength(0);
  }, 120_000);

  it("a user-launched flow run with context_repos still materializes its mount", async () => {
    const sibling = await createSiblingProject();
    const userId = await createAdminUser();
    const seeded = await seedRun({
      manifest: flowWithMounts(sibling.slug),
      createdByUserId: userId,
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: (await makeSupervisorSpy(seeded.runId)).hosts,
    });

    // The path the agent-driven refusal must not disturb: launching user holds
    // readRepoFiles, so the mount resolves, materializes, and is snapshotted.
    const snapshot = await loadSnapshot(seeded.runId);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      projectId: sibling.projectId,
      slug: sibling.slug,
    });
    expect(
      (
        await readFile(join(snapshot[0].mountPath, "CONTRACT.md"), "utf8")
      ).trim(),
    ).toBe("CONTRACT-V1");
  }, 120_000);
});
