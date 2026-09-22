import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startMainAndBrainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
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
import {
  seedAdmin,
  seedMember,
  WORKER_ADMIN,
  WORKER_MEMBER,
} from "@/test-support/durable-workers-seed";
import { mkdtempReal } from "@/test-support/worktree-test-root";

describe("scheduler clock in a production web", () => {
  let database: StartedPostgresTestDb;
  let supervisor: RealSupervisor;
  let web: RealWeb | undefined;
  let root = "";
  let runtimeRoot = "";
  let worktreesRoot = "";

  beforeAll(async () => {
    database = await startMainAndBrainPostgresTestDb({
      databaseName: "scheduler_clock_boot",
    });
    root = await mkdtempReal("scheduler-clock-boot-");
    runtimeRoot = path.join(root, "web");
    worktreesRoot = path.join(root, "worktrees");
    const supervisorRoot = path.join(root, "supervisor");

    await Promise.all(
      [runtimeRoot, worktreesRoot, supervisorRoot].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    supervisor = await startRealSupervisor({
      runtimeRoot: supervisorRoot,
      workspaceRoots: [root],
      fixtureArgs: ["--hang"],
    });
    await seedAdmin(database.db);
    await seedMember(database.db);
    await buildProductionWeb(path.join(root, "next-build.log"));
  }, 900_000);

  afterAll(async () => {
    await web?.kill();
    await supervisor?.kill();
    await database?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  }, 180_000);

  async function start(
    name: string,
    env: Record<string, string | undefined>,
  ): Promise<RealWeb> {
    await web?.stop();
    web = await startRealWeb({
      databaseUrl: database.container.getConnectionUri(),
      supervisorUrl: supervisor.url,
      runtimeRoot,
      worktreesRoot,
      logFile: path.join(root, `${name}.log`),
      env,
    });

    return web;
  }

  it("starts the fallback clock when both clock variables are absent", async () => {
    const current = await start("fallback", {
      MAISTER_SCHEDULER_TIMER_ENABLED: undefined,
      MAISTER_CRON_TOKEN: undefined,
    });
    const log = await current.logTail();

    expect(log).toContain("scheduler fallback timer started");
    expect(log).toContain('"driver":"fallback_timer"');

    const cookie = await signInWithCredentials(current.url, WORKER_ADMIN);
    const page = await fetch(`${current.url}/admin/scheduler`, {
      headers: { cookie },
    });
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain("Scheduler clock");
    expect(html).toContain("Fallback timer");
  });

  it("warns for an explicitly missing clock and ignores retired timer settings", async () => {
    const current = await start("missing", {
      MAISTER_SCHEDULER_TIMER_ENABLED: "false",
      MAISTER_CRON_TOKEN: undefined,
      MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS: "invalid",
      MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS: "",
    });
    const log = await current.logTail();

    expect(log).toContain("scheduler clock is not configured");
    expect(log).toContain("MAISTER_SCHEDULER_TIMER_ENABLED");
    expect(log).toContain("MAISTER_CRON_TOKEN");
    expect(log).toContain("MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS");
    expect(log).toContain("MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS");
    expect(log.match(/scheduler interval variable ignored/g)).toHaveLength(2);
  });

  it("refuses production boot for an invalid lag threshold", async () => {
    const logFile = path.join(root, "invalid-lag.log");

    await expect(
      startRealWeb({
        databaseUrl: database.container.getConnectionUri(),
        supervisorUrl: supervisor.url,
        runtimeRoot,
        worktreesRoot,
        logFile,
        env: { MAISTER_EVENT_STREAM_LAG_SECONDS: "invalid" },
      }),
    ).rejects.toThrow(/startup failed|exited before/);
    const log = await readFile(logFile, "utf8");

    expect(log).toContain(
      "MAISTER_EVENT_STREAM_LAG_SECONDS must be a canonical positive integer",
    );
  });

  it("refuses production boot for an invalid scheduler clock setting", async () => {
    const logFile = path.join(root, "invalid-clock.log");

    await expect(
      startRealWeb({
        databaseUrl: database.container.getConnectionUri(),
        supervisorUrl: supervisor.url,
        runtimeRoot,
        worktreesRoot,
        logFile,
        env: { MAISTER_SCHEDULER_TIMER_ENABLED: "yes" },
      }),
    ).rejects.toThrow(/startup failed|exited before/);
    const log = await readFile(logFile, "utf8");

    expect(log).toContain(
      "MAISTER_SCHEDULER_TIMER_ENABLED must be the literal true or false when set",
    );
    // The refusal must precede the durable workers, not follow them.
    expect(log).not.toContain("prompt-owner-worker-started");
  });

  it("E1: a member is refused the execution-host page with a literal 403", async () => {
    const current = await start("member-403", {
      MAISTER_SCHEDULER_TIMER_ENABLED: undefined,
      MAISTER_CRON_TOKEN: undefined,
    });
    const cookie = await signInWithCredentials(current.url, WORKER_MEMBER);
    const page = await fetch(`${current.url}/admin/execution-host`, {
      headers: { cookie },
      redirect: "manual",
    });
    const html = await page.text();

    expect(page.status).toBe(403);
    // Assert on DTO CONTENT, not on panel labels: the i18n catalog ships with
    // every page, so `adminExecutionHost.streams.title` is in the payload of a
    // refusal too and would make a label assertion pass for the wrong reason.
    expect(html).not.toContain("hostKey");
    expect(html).not.toContain("readinessReason");
    expect(html).not.toContain("execution:projection:rearm");

    const admin = await signInWithCredentials(current.url, WORKER_ADMIN);

    expect(
      (
        await fetch(`${current.url}/admin/execution-host`, {
          headers: { cookie: admin },
        })
      ).status,
    ).toBe(200);
  });

  it("records durable job activity when an external clock invokes the route", async () => {
    const token = "scheduler-clock-production-test";
    const current = await start("external", {
      MAISTER_SCHEDULER_TIMER_ENABLED: "false",
      MAISTER_CRON_TOKEN: token,
      MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS: undefined,
      MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS: undefined,
    });
    const tick = await fetch(`${current.url}/api/cron/tick`, {
      method: "POST",
      headers: { "X-Maister-Cron-Token": token },
    });

    expect(tick.status).toBe(200);
    expect(await current.logTail()).not.toContain(
      "scheduler fallback timer started",
    );

    // The point of an external clock is that the DURABLE rows advance, so
    // assert the observed attempt rather than accepting any terminal status.
    const attempts = await database.db.execute(sql`
      SELECT status, finished_at FROM scheduler_job_runs
      WHERE job_id = 'system_sweep.default'
      ORDER BY claimed_at DESC, id DESC LIMIT 1
    `);
    const sweep = attempts.rows[0] as
      | { status: string; finished_at: string | null }
      | undefined;

    expect(sweep?.status).toBe("Succeeded");
    expect(sweep?.finished_at).not.toBeNull();

    const cookie = await signInWithCredentials(current.url, WORKER_ADMIN);
    const page = await fetch(`${current.url}/admin/scheduler`, {
      headers: { cookie },
    });
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain("External tick expected");
    expect(html).toContain("system_sweep.default");
    expect(html).toContain("domain_event_dispatch.default");
    expect(html).toContain("Succeeded");
  });
}, 1_200_000);
