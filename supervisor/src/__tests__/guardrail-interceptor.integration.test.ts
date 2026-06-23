// ADR-104 (M40): end-to-end guardrail interceptor against a scripted mock ACP
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

async function boot(fixtureArgs: string[]): Promise<BootResult> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "guardrail-it-"));
  const registry = new SessionRegistry(silentLogger);
  const app = Fastify({ logger: false });
  const spawnOverrides: SpawnOverrides = {
    binary: "node",
    preArgs: [FIXTURE_PATH, ...fixtureArgs],
  };

  registerRoutes({
    app,
    registry,
    logger: silentLogger,
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
});
