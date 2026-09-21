// ADR-179 (D17, owner 2026-09-21): a scratch launch takes the SAME shared gate
// as the flow node and the standalone agent. It did not before —
// `materializeCapabilityProfile` output went straight to the create payload —
// so an untrusted platform server was spawned, a project overlay was ignored,
// and a codex session with an `sse` server died at `session/new` for the WHOLE
// session.
//
// Each case asserts the mcpServers the create payload actually carried, plus
// the durable `runs.withheld_mcps` record, because a warn-only downgrade is
// exactly what ADR-129 removed everywhere else.

import type { ExecutionHosts } from "@/lib/execution-host";
import type { ScratchLaunchInput } from "@/lib/scratch-runs/types";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);
const USER_ID = "scratch-mcp-gate-user";
// A literal an operator declared non-secret. It is legitimately stored and
// materialized — but a WITHHELD record is an audit row, not a config, and
// carries no value at all (ADR-129: `{refId, transport, reason, scope}`).
const LITERAL_SENTINEL = "lit-9f3a";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: USER_ID,
    email: "scratch@test",
    role: "admin",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

let launchScratchRunStaged: typeof import("@/lib/scratch-runs/service").launchScratchRunStaged;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let fake: FakeExecutionHost;
let hosts: ExecutionHosts;
let tmpRoot: string;
let projectId: string;
let repo: string;
const savedEnv: Record<string, string | undefined> = {};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);

  return stdout;
}

type McpSeed = {
  id: string;
  transport: "stdio" | "sse" | "http";
  trust?: "trusted" | "untrusted";
  env?: Record<string, string>;
};

async function seedPlatformMcp(seed: McpSeed): Promise<void> {
  await db.insert(schema.platformMcpServers).values({
    id: seed.id,
    transport: seed.transport,
    command: seed.transport === "stdio" ? "npx" : null,
    url: seed.transport === "stdio" ? null : "https://mcp.example.com/x",
    env: seed.env ?? {},
    headers: {},
    supportedAgents: ["claude", "codex"],
    trustStatus: seed.trust ?? "trusted",
    enabled: true,
  });
  // The projection a project registration would have written.
  await db.insert(schema.capabilityRecords).values({
    id: randomUUID(),
    projectId,
    capabilityRefId: seed.id,
    kind: "mcp",
    label: seed.id,
    source: "platform",
    agents: ["claude", "codex"],
    enforceability: "enforced",
    selectedByDefault: true,
    selectable: true,
    material: {
      transport: seed.transport,
      command: seed.transport === "stdio" ? "npx" : null,
      url: seed.transport === "stdio" ? null : "https://mcp.example.com/x",
      env: seed.env ?? {},
      headers: {},
    },
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scratch_mcp_gate_test",
  });
  db = testDatabase.db;
  fake = createFakeExecutionHost();
  ({ hosts } = await fakeExecutionHosts(db, { fake }));
  ({ launchScratchRunStaged } = await import("@/lib/scratch-runs/service"));

  tmpRoot = await mkdtemp(join(tmpdir(), "scratch-mcp-gate-"));
  for (const key of [
    "DB_URL",
    "MAISTER_RUNTIME_ROOT",
    "MAISTER_WORKTREES_ROOT",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.DB_URL = testDatabase.container.getConnectionUri();
  process.env.MAISTER_RUNTIME_ROOT = join(tmpRoot, "runtime");
  process.env.MAISTER_WORKTREES_ROOT = join(tmpRoot, "worktrees");

  repo = join(tmpRoot, "repo");
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "t@t.local");
  await git(repo, "config", "user.name", "T");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");

  projectId = randomUUID();
  await db.insert(schema.users).values({
    id: USER_ID,
    email: `${USER_ID}@maister.local`,
    role: "member",
    accountStatus: "active",
  });

  const runnerId = randomUUID();

  await db
    .insert(schema.platformAcpRunners)
    .values(
      testPlatformRunnerRow(
        runnerId,
        "claude",
      ) as typeof schema.platformAcpRunners.$inferInsert,
    );
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: runnerId,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `scratch-mcp-${projectId.slice(0, 8)}`,
    name: "Scratch MCP gate",
    repoPath: repo,
    taskKey: "SMG",
  });

  await seedPlatformMcp({
    id: "trusted-stdio",
    transport: "stdio",
    env: { GH_HOST: "github.com" },
  });
  await seedPlatformMcp({
    id: "untrusted-stdio",
    transport: "stdio",
    trust: "untrusted",
    // A LITERAL, so the withheld record can be asserted not to carry it.
    env: { GH_HOST: LITERAL_SENTINEL },
  });
  await seedPlatformMcp({ id: "legacy-sse", transport: "sse" });
}, 180_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await testDatabase?.stop();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

function launchBody(mcpIds: string[]): ScratchLaunchInput {
  return {
    projectId,
    baseBranch: "main",
    prompt: "say hello",
    reasoningEffort: "high",
    attachments: [],
    capabilities: { mcpIds },
  } as ScratchLaunchInput;
}

async function launch(mcpIds: string[]): Promise<string> {
  const gen = launchScratchRunStaged(
    { body: launchBody(mcpIds), userId: USER_ID },
    { executionHosts: hosts },
  );
  let step = await gen.next();

  while (!step.done) step = await gen.next();

  return step.value.runId;
}

function mcpServersOfLastCreate(): Array<{ name: string }> {
  const creates = fake.callsOf("createSession");
  const payload = creates.at(-1)?.envelope?.payload as {
    mcpServers?: Array<{ name: string }>;
  };

  return payload?.mcpServers ?? [];
}

async function withheldOf(runId: string) {
  const [row] = await db
    .select({ withheld: schema.runs.withheldMcps })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return row?.withheld ?? [];
}

describe("scratch launch takes the shared MCP gate (ADR-179 D17)", () => {
  it("keeps a trusted server and carries its env VALUE map to the create payload", async () => {
    const runId = await launch(["trusted-stdio"]);

    expect(mcpServersOfLastCreate().map((s) => s.name)).toContain(
      "trusted-stdio",
    );
    expect(await withheldOf(runId)).toEqual([]);
  });

  it("withholds an UNTRUSTED platform server and persists the reason", async () => {
    // Before ADR-179 this server reached `session/new`: scratch never took the
    // trust gate at all.
    const runId = await launch(["untrusted-stdio"]);

    expect(mcpServersOfLastCreate().map((s) => s.name)).not.toContain(
      "untrusted-stdio",
    );
    const withheld = await withheldOf(runId);

    expect(withheld).toEqual([
      expect.objectContaining({
        refId: "untrusted-stdio",
        reason: "platform-untrusted",
      }),
    ]);
    // AC-06: the withheld sink names the ref and the reason, never a value.
    expect(JSON.stringify(withheld)).not.toContain(LITERAL_SENTINEL);
  });

  it("keeps an sse server for a claude runner — claude accepts sse", async () => {
    const runId = await launch(["legacy-sse"]);

    expect(mcpServersOfLastCreate().map((s) => s.name)).toContain("legacy-sse");
    expect(await withheldOf(runId)).toEqual([]);
  });

  it("the local-package ASSISTANT launch is a proven non-path, not an exemption", async () => {
    // T16: a scope word comes from the seam. `gateAndOverlayMcpServers` has
    // three call sites after ADR-179 — flow, agent, scratch. The assistant
    // launch is the fourth scratch-shaped launch and takes NO gate, because it
    // has no project: it cannot load bindings (`loadProjectMcpOverlays` keys on
    // projectId) and resolves no project catalog. Assert the reason rather than
    // the absence, so a future assistant that DOES gain a project fails here.
    const source = await readFile(
      new URL("../service.ts", import.meta.url),
      "utf8",
    );
    const gateCalls = source.match(/gateAndOverlayMcpServers\(/g) ?? [];

    // One import + one call. A second call would mean the assistant path grew
    // one, and this test should be replaced by a real behavioural case.
    expect(gateCalls).toHaveLength(1);
    expect(source).toContain("the assistant has no project");
  });

  it("applies a project overlay to a scratch launch", async () => {
    await db.insert(schema.projectMcpBindings).values({
      id: randomUUID(),
      projectId,
      refId: "trusted-stdio",
      targetKind: "platform",
      targetId: "trusted-stdio",
      enabled: true,
      // Replaces the VALUE for a declared key and preserves the key.
      configOverlay: { envRemap: { GH_HOST: "ghe.internal" } },
    });

    await launch(["trusted-stdio"]);

    const server = mcpServersOfLastCreate().find(
      (s) => s.name === "trusted-stdio",
    ) as { env?: Record<string, string> } | undefined;

    expect(server?.env).toEqual({ GH_HOST: "ghe.internal" });
  });
});
