// AT-16 (AB-16, D10) — the single-host web/supervisor boundary under REAL
// process isolation, with the production entrypoints on both sides:
//
//   the supervisor is `supervisor/src/main.ts` on a private runtime root;
//   the web is `server.ts` over a fresh `next build`, wrapped in a kernel
//   isolation driver that denies the supervisor's root to its whole process
//   tree; both share only Postgres, the HTTP port and the worktrees root.
//
//   I1 negative control — the web identity cannot read the host's private
//      root (the seeded sentinel AND the live host-state store); the harness
//      and the host itself can (positive control); the deny is scoped
//   I2 lifecycle — sign-in, scratch launch with an upload, prompt completion
//      by the host, object read and transcript history through HTTP/Postgres
//   I3 restart — a SIGKILLed web boots again through production
//      initialization under the same isolation and serves the same history,
//      the same bytes, and completes a further turn
//   I4 the supervisor is unaffected by the web's death and restart
//
// Environment failure (no isolation driver, no Docker, no build) fails the
// suite explicitly; it never degrades to an unisolated run.
import type { Db } from "@/lib/execution-host/db";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readLaunchResult } from "@/e2e/_seed/launch-stream";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schema from "@/lib/db/schema";
import { initRepo } from "@/test-support/git-fixture";
import {
  startMainAndBrainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  probeFilesystemAccess,
  resolveIsolationDriver,
  type IsolationDriver,
} from "@/test-support/process-isolation";
import {
  startRealSupervisor,
  type RealSupervisor,
} from "@/test-support/real-supervisor";
import {
  buildProductionWeb,
  signInWithCredentials,
  startRealWeb,
  type RealWeb,
} from "@/test-support/real-web";
import { mkdtempReal } from "@/test-support/worktree-test-root";

const ADMIN = {
  email: "isolation-admin@maister.local",
  password: "Isolation!pass1",
};
const UPLOAD_BYTES = new TextEncoder().encode("isolated upload bytes\n");
// Build/web/supervisor logs survive the run when an evidence directory is
// given (they are the harness's safe traces); otherwise they live in `base`.
const EVIDENCE_DIR = process.env.MAISTER_TEST_EVIDENCE_DIR;

let driver: IsolationDriver;
let testDatabase: StartedPostgresTestDb;
let db: Db;
let base = "";
let supervisorRoot = "";
let webRoot = "";
let worktreesRoot = "";
let sentinel = "";
let supervisor: RealSupervisor;
let web: RealWeb;
let projectId = "";
let cookie = "";
let runId = "";
let objectId = "";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function api(
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${web.url}${pathname}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
  });
}

async function poll<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await read();

    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function scratchDetail(): Promise<{
  run: { status: string };
  scratch: { dialogStatus: string };
  attachments: Array<{
    kind: string;
    artifactRef: string | null;
    sha256: string | null;
  }>;
  messages: unknown[];
}> {
  const res = await api(`/api/scratch-runs/${runId}`);

  if (res.status !== 200)
    throw new Error(`scratch detail answered ${res.status}`);

  return (await res.json()) as never;
}

async function waitForTurnToSettle(): Promise<void> {
  await poll(
    async () => {
      const detail = await scratchDetail();

      return detail.scratch.dialogStatus === "WaitingForUser" ? detail : null;
    },
    120_000,
    "the scratch turn to settle (dialogStatus WaitingForUser)",
  );
}

describe("AT-16 isolated single-host lifecycle", () => {
  beforeAll(async () => {
    driver = resolveIsolationDriver();
    testDatabase = await startMainAndBrainPostgresTestDb({
      databaseName: "execution_ab_isolation",
    });
    db = testDatabase.db as unknown as Db;
    base = await mkdtempReal("execution-ab-iso-");
    supervisorRoot = path.join(base, "supervisor");
    webRoot = path.join(base, "web");
    worktreesRoot = path.join(base, "worktrees");
    sentinel = path.join(supervisorRoot, "sentinel.txt");
    await Promise.all(
      [supervisorRoot, webRoot, worktreesRoot].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    await writeFile(sentinel, "host-private\n");
    await writeFile(path.join(webRoot, "web-private.txt"), "web-private\n");
    const repo = await initRepo(path.join(base, "repo"));

    supervisor = await startRealSupervisor({
      runtimeRoot: supervisorRoot,
      workspaceRoots: [worktreesRoot],
      // The adapter stays alive between turns and advertises resume, so the
      // restarted web must re-attach to a LIVE host session for the extra turn.
      fixtureArgs: ["--hang", "--lines", "1", "--supports-resume"],
      ...(EVIDENCE_DIR
        ? { logFile: path.join(EVIDENCE_DIR, "supervisor.log") }
        : {}),
    });

    const runnerId = randomUUID();
    const userId = randomUUID();

    projectId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      email: ADMIN.email,
      name: "Isolation admin",
      passwordHash: await bcrypt.hash(ADMIN.password, 10),
      role: "admin",
      accountStatus: "active",
      mustChangePassword: false,
    });
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
      slug: `iso-${projectId.slice(0, 8)}`,
      name: "Isolation project",
      repoPath: repo,
      taskKey: "ISO",
    });

    const logs = EVIDENCE_DIR ?? base;

    await mkdir(logs, { recursive: true });
    const buildId = await buildProductionWeb(path.join(logs, "next-build.log"));

    web = await startRealWeb({
      databaseUrl: testDatabase.container.getConnectionUri(),
      supervisorUrl: supervisor.url,
      runtimeRoot: webRoot,
      worktreesRoot,
      isolation: { driver, deniedRoots: [supervisorRoot] },
      logFile: path.join(logs, "web.log"),
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        harness: "execution-ab-isolation",
        isolation: driver.name,
        node: process.versions.node,
        buildId,
        supervisorPid: supervisor.pid,
        webPid: web.pid,
        logs,
        roots: { supervisor: "private", web: "private", worktrees: "shared" },
      }),
    );
  }, 600_000);

  afterAll(async () => {
    await web?.kill();
    await supervisor?.kill();
    await testDatabase?.stop();
    if (base) await rm(base, { recursive: true, force: true });
  }, 120_000);

  it("I1: the web identity is denied the host's private root while the harness and the host keep it", async () => {
    const denied = [supervisorRoot];

    expect(await probeFilesystemAccess(driver, denied, sentinel)).toEqual({
      outcome: "denied",
      code: driver.deniedCode,
    });
    expect(
      await probeFilesystemAccess(
        driver,
        denied,
        path.join(supervisor.stateDir, "state.sqlite"),
      ),
    ).toEqual({ outcome: "denied", code: driver.deniedCode });
    // The deny is scoped: the same identity reads its own root and the file
    // exists for the harness, so the denial is the boundary, not absence.
    expect(
      await probeFilesystemAccess(
        driver,
        denied,
        path.join(webRoot, "web-private.txt"),
      ),
    ).toEqual({ outcome: "readable", bytes: 12 });
    expect(await readFile(sentinel, "utf8")).toBe("host-private\n");
    const health = await fetch(`${supervisor.url}/health`);

    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ready");
  });

  it("I2: a launch with an upload completes through HTTP and Postgres, and the object and history read back", async () => {
    cookie = await signInWithCredentials(web.url, ADMIN);
    const form = new FormData();

    form.append(
      "payload",
      JSON.stringify({
        projectId,
        baseBranch: "main",
        name: `isolation ${randomUUID().slice(0, 8)}`,
        prompt: "Summarize the attached file.",
        reasoningEffort: "high",
        attachments: [],
      }),
    );
    form.append(
      "files",
      new Blob([UPLOAD_BYTES], { type: "text/plain" }),
      "notes.txt",
    );
    const launch = await api("/api/scratch-runs", {
      method: "POST",
      body: form,
    });

    expect(launch.status).toBe(200);
    ({ runId } = await readLaunchResult(launch));
    await waitForTurnToSettle();
    const detail = await scratchDetail();
    const upload = detail.attachments.find(
      (entry) => entry.kind === "uploaded_file",
    );

    expect(upload?.sha256).toBe(sha256(UPLOAD_BYTES));
    objectId = upload?.artifactRef as string;
    await poll(
      async () => {
        const [row] = await testDatabase.db
          .select({ state: schema.executionRuntimeObjects.state })
          .from(schema.executionRuntimeObjects)
          .where(eq(schema.executionRuntimeObjects.id, objectId));

        return row?.state === "available" ? row : null;
      },
      60_000,
      "the upload's catalog row to become available",
    );
    const content = await api(
      `/api/runs/${runId}/runtime-objects/${objectId}/content`,
    );

    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(content.headers.get("content-disposition")).toMatch(/^attachment; /);
    expect(sha256(new Uint8Array(await content.arrayBuffer()))).toBe(
      sha256(UPLOAD_BYTES),
    );
    const transcript = await api(`/api/runs/${runId}/transcript`);

    expect(transcript.status).toBe(200);
    expect(detail.messages.length).toBeGreaterThan(0);
  });

  it("I3: a SIGKILLed web restarts through production initialization under the same isolation and continues the run", async () => {
    const before = await scratchDetail();

    web = await web.restart();
    const after = await scratchDetail();

    expect(after.messages.length).toBe(before.messages.length);
    const content = await api(
      `/api/runs/${runId}/runtime-objects/${objectId}/content`,
    );

    expect(content.status).toBe(200);
    expect(sha256(new Uint8Array(await content.arrayBuffer()))).toBe(
      sha256(UPLOAD_BYTES),
    );
    const message = await api(`/api/scratch-runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "one more turn after the restart",
        attachments: [],
      }),
    });

    expect(
      [200, 202],
      `follow-up message answered ${message.status}: ${await message.text()}`,
    ).toContain(message.status);
    await waitForTurnToSettle();
    expect((await scratchDetail()).messages.length).toBeGreaterThan(
      before.messages.length,
    );
  });

  it("I4: the supervisor and its private root are untouched by the web's death and restart", async () => {
    const health = await fetch(`${supervisor.url}/health`);

    expect(health.status).toBe(200);
    expect(await readFile(sentinel, "utf8")).toBe("host-private\n");
    expect(
      await probeFilesystemAccess(driver, [supervisorRoot], sentinel),
    ).toEqual({
      outcome: "denied",
      code: driver.deniedCode,
    });
  });
});
