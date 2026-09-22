import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

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
import { seedAdmin, WORKER_ADMIN } from "@/test-support/durable-workers-seed";
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

    expect([200, 207]).toContain(tick.status);

    const cookie = await signInWithCredentials(current.url, WORKER_ADMIN);
    const page = await fetch(`${current.url}/admin/scheduler`, {
      headers: { cookie },
    });
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain("External tick expected");
    expect(html).toContain("system_sweep.default");
    expect(html).toContain("domain_event_dispatch.default");
    expect(html).toMatch(/Succeeded|Failed/);
  });
}, 1_200_000);
