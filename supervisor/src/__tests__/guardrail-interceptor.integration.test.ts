// ADR-108 (M40): end-to-end guardrail interceptor against a scripted mock ACP
// adapter. The mock drives the REAL requestPermission / sessionUpdate closures in
// createAcpConnection; we assert on the session.hook_trip events the supervisor
// buffers. Sessions run with autoApprovePermissions=true (an unattended run), so
// non-tripping permission requests auto-approve via B1 — yet guardrails still
// deny/halt, proving the interceptor runs BEFORE B1 (not bypassed by auto-approve).

import type { SessionEvent } from "../types";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { registerRoutes, type SpawnOverrides } from "../http-api";
import { pendingPermissions } from "../pending-permissions";
import { SessionRegistry } from "../registry";

const FIXTURE_PATH = resolve(
  fileURLToPath(import.meta.url),
  "../../../test/fixtures/mock-acp-guardrail.mjs",
);
const silentLogger = pino({ level: "silent" });

type BootResult = {
  app: FastifyInstance;
  url: string;
  registry: SessionRegistry;
  runtimeRoot: string;
};

let booted: BootResult | null = null;

async function boot(
  fixtureArgs: string[],
  logger = silentLogger,
): Promise<BootResult> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "guardrail-it-"));
  const registry = new SessionRegistry(logger);
  const app = Fastify({ logger: false });
  const spawnOverrides: SpawnOverrides = {
    binary: "node",
    preArgs: [FIXTURE_PATH, ...fixtureArgs],
  };

  registerRoutes({
    app,
    registry,
    logger,
    runtimeRoot,
    killGraceMs: 2_000,
    spawnOverrides,
  });

  const url = await app.listen({ port: 0, host: "127.0.0.1" });

  booted = { app, url, registry, runtimeRoot };

  return booted;
}

type SessionOpts = {
  hooksConfig?: unknown;
  autoApprovePermissions?: boolean;
  worktreePath: string;
};

async function createSession(url: string, opts: SessionOpts): Promise<string> {
  const res = await fetch(`${url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: "run-guard",
      projectSlug: "demo",
      worktreePath: opts.worktreePath,
      stepId: "step-1",
      executor: { agent: "claude", model: "claude-sonnet-4-6" },
      autoApprovePermissions: opts.autoApprovePermissions ?? true,
      ...(opts.hooksConfig ? { hooksConfig: opts.hooksConfig } : {}),
    }),
  });

  if (res.status !== 201) {
    throw new Error(`POST /sessions failed: ${res.status} ${await res.text()}`);
  }

  return ((await res.json()) as { sessionId: string }).sessionId;
}

async function sendPrompt(url: string, sessionId: string): Promise<void> {
  const res = await fetch(`${url}/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stepId: "step-1", prompt: "go" }),
  });

  if (res.status !== 200) {
    throw new Error(`prompt failed: ${res.status} ${await res.text()}`);
  }
}

function hookTrips(events: SessionEvent[]) {
  return events.filter(
    (e): e is Extract<SessionEvent, { type: "session.hook_trip" }> =>
      e.type === "session.hook_trip",
  );
}

afterEach(async () => {
  if (!booted) return;
  booted.registry.forEach((entry) => entry.child.kill("SIGKILL"));
  await booted.app.close();
  await rm(booted.runtimeRoot, { recursive: true, force: true });
  booted = null;
});

describe("guardrail interceptor (universal supervisor seam)", () => {
  it("repetition: halts at EXACTLY max identical tool calls (overriding auto-approve)", async () => {
    const { url, registry, runtimeRoot } = await boot([
      "--scenario",
      "repetition",
      "--count",
      "5",
    ]);
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      hooksConfig: { repetition: { max: 5 } },
    });

    await sendPrompt(url, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      rule: "repetition",
      lifecycle: "pre_tool_call",
      disposition: "halt",
    });
    // The tripping call carried a toolCall; no permission deferred leaked.
    expect(trips[0].toolCall).toBeTruthy();
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("path_guard: denies an out-of-lane write but allows the in-lane one (deny-and-continue)", async () => {
    const { url, registry, runtimeRoot } = await boot([
      "--scenario",
      "path_guard",
    ]);
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      hooksConfig: { pathGuard: { allowedPaths: ["src/**"] } },
    });

    await sendPrompt(url, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    // Exactly one trip: the out-of-lane write. The in-lane write passed (no trip),
    // proving the run continues after a deny.
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      rule: "path_guard",
      lifecycle: "pre_tool_call",
      disposition: "deny",
    });
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("no_progress: halts after maxTurns idle tool-call turns", async () => {
    const { url, registry, runtimeRoot } = await boot([
      "--scenario",
      "no_progress",
      "--count",
      "4",
    ]);
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      hooksConfig: { noProgress: { maxTurns: 4 } },
    });

    await sendPrompt(url, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      rule: "no_progress",
      lifecycle: "post_turn",
      disposition: "halt",
      toolCall: null,
    });
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("no hooksConfig: the interceptor is a no-op (byte-identical to a pre-hook run)", async () => {
    const { url, registry, runtimeRoot } = await boot([
      "--scenario",
      "repetition",
      "--count",
      "5",
    ]);
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      // No hooksConfig — every call just auto-approves via B1.
    });

    await sendPrompt(url, sessionId);

    expect(hookTrips(registry.snapshotEvents(sessionId))).toHaveLength(0);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("repetition: trips exactly once, then short-circuits every later call (hookHalted)", async () => {
    const { url, registry, runtimeRoot } = await boot([
      "--scenario",
      "repetition",
      "--count",
      "7",
    ]);
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      hooksConfig: { repetition: { max: 5 } },
    });

    await sendPrompt(url, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    // 7 identical calls, max 5: the 5th halts; calls 6 & 7 are cancelled inline
    // by hookHalted WITHOUT a second trip — one escalation per halt.
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ rule: "repetition", disposition: "halt" });
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("halt cancels an OPEN permission deferred (no leaked deferred)", async () => {
    const { url, registry, runtimeRoot } = await boot([
      "--scenario",
      "deferred_cancel",
      "--count",
      "3",
    ]);
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      // autoApprove OFF → the write opens a real HITL deferred (no inline allow).
      autoApprovePermissions: false,
      hooksConfig: { noProgress: { maxTurns: 3 } },
    });

    // Resolves ONLY because the no_progress halt cancels the open deferred (the
    // mock awaits it); a leak would hang the prompt past the test timeout.
    await sendPrompt(url, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      rule: "no_progress",
      disposition: "halt",
    });
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("no_progress: a write turn resets the counter (no trip below maxTurns idle)", async () => {
    const { url, registry, runtimeRoot } = await boot([
      "--scenario",
      "no_progress_reset",
      "--count",
      "4",
    ]);
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      hooksConfig: { noProgress: { maxTurns: 4 } },
    });

    await sendPrompt(url, sessionId);

    // 3 idle, one write (reset), 3 idle — never 4 consecutive idle → no halt.
    expect(hookTrips(registry.snapshotEvents(sessionId))).toHaveLength(0);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("path_guard: kind-only writes are each denied, WARNed once per session", async () => {
    const warns: Array<Record<string, unknown>> = [];
    const captureLogger = pino(
      { level: "warn" },
      {
        write: (s: string) =>
          warns.push(JSON.parse(s) as Record<string, unknown>),
      },
    );
    const { url, registry, runtimeRoot } = await boot(
      ["--scenario", "path_guard_kindonly", "--count", "2"],
      captureLogger,
    );
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      hooksConfig: { pathGuard: { allowedPaths: ["src/**"] } },
    });

    await sendPrompt(url, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    // Both kind-only writes are denied (deny-and-continue) ...
    expect(trips).toHaveLength(2);
    expect(trips.every((t) => t.rule === "path_guard")).toBe(true);
    // ... but the fallback WARN fires once per session, not once per call.
    const fallbackWarns = warns.filter((w) =>
      String(w.msg ?? "").includes("kind-only fallback"),
    );

    expect(fallbackWarns).toHaveLength(1);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("path_guard + repetition + no_progress armed: repeated identical denied writes halt EXACTLY once", async () => {
    const { url, registry, runtimeRoot } = await boot([
      "--scenario",
      "path_guard_repeat",
      "--count",
      "6",
    ]);
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      hooksConfig: {
        pathGuard: { allowedPaths: ["src/**"] },
        repetition: { max: 3 },
        noProgress: { maxTurns: 15 },
      },
    });

    await sendPrompt(url, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));
    const halts = trips.filter((t) => t.disposition === "halt");
    const denies = trips.filter((t) => t.rule === "path_guard");

    // Repeated out-of-lane writes (deny-and-continue) now feed the repetition
    // breaker, which halts at EXACTLY max — once, not zero (the pre-fix infinite
    // loop) and not twice. The 2 denials before it continue; calls after the
    // halt are cancelled inline (hookHalted) with no further trips.
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ rule: "repetition", disposition: "halt" });
    expect(denies).toHaveLength(2);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("path_guard + no_progress only: repeated denied writes halt via the deny-branch no_progress tick", async () => {
    const { url, registry, runtimeRoot } = await boot([
      "--scenario",
      "path_guard_repeat",
      "--count",
      "6",
    ]);
    const sessionId = await createSession(url, {
      worktreePath: runtimeRoot,
      // No repetition armed → only the deny-branch no_progress tick can halt a
      // stream of denied writes (proves the tick fires independently).
      hooksConfig: {
        pathGuard: { allowedPaths: ["src/**"] },
        noProgress: { maxTurns: 4 },
      },
    });

    await sendPrompt(url, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));
    const halts = trips.filter((t) => t.disposition === "halt");

    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({
      rule: "no_progress",
      disposition: "halt",
      toolCall: null,
    });
    // 3 denials (maxTurns - 1) precede the no_progress halt.
    expect(trips.filter((t) => t.rule === "path_guard")).toHaveLength(3);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });
});
