// ADR-108 (M40): end-to-end guardrail interceptor against a scripted mock ACP
// adapter. The mock drives the REAL requestPermission / sessionUpdate closures in
// createAcpConnection; we assert on the session.hook_trip events the supervisor
// buffers. Sessions run with autoApprovePermissions=true (an unattended run), so
// non-tripping permission requests auto-approve via B1 — yet guardrails still
// deny/halt, proving the interceptor runs BEFORE B1 (not bypassed by auto-approve).

import type { SessionEvent } from "../types";
import type { Logger } from "pino";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { pendingPermissions } from "../pending-permissions";

import {
  adoptDirectory,
  bootHost,
  cleanupRuntimeRoot,
  completePrompt,
  createBody,
  envelope,
  fenceFor,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

const RUN_ID = "run-guard";

let booted: BootedHost | null = null;

async function boot(
  fixtureArgs: string[],
  logger?: Logger,
): Promise<BootedHost> {
  booted = await bootHost({
    fixture: "mock-acp-guardrail.mjs",
    fixtureArgs,
    logger,
  });

  return booted;
}

type SessionOpts = {
  hooksConfig?: unknown;
  enforcementProfile?: unknown;
  autoApprovePermissions?: boolean;
  // The directory adopted as the session workspace (cwd + path-guard root).
  cwd: string;
};

async function createSession(
  host: BootedHost,
  opts: SessionOpts,
): Promise<string> {
  const handle = await adoptDirectory(
    host,
    { runId: RUN_ID },
    { dir: opts.cwd },
  );
  const res = await postJson(
    `${host.url}/sessions`,
    envelope(
      "session.create",
      fenceFor(host, RUN_ID),
      createBody(handle, {
        autoApprovePermissions: opts.autoApprovePermissions ?? true,
        ...(opts.hooksConfig ? { hooksConfig: opts.hooksConfig } : {}),
        ...(opts.enforcementProfile
          ? { enforcementProfile: opts.enforcementProfile }
          : {}),
      }),
    ),
  );

  if (res.status !== 201) {
    throw new Error(
      `POST /sessions failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  return (res.body as { sessionId: string }).sessionId;
}

async function sendPrompt(host: BootedHost, sessionId: string): Promise<void> {
  const res = await completePrompt(
    host,
    sessionId,
    envelope("session.prompt", fenceFor(host, RUN_ID), {
      stepId: "step-1",
      prompt: "go",
    }),
  );

  if (res.status !== 200) {
    throw new Error(`prompt failed: ${res.status} ${JSON.stringify(res.body)}`);
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
  await booted.stop();
  await cleanupRuntimeRoot(booted.runtimeRoot);
  booted = null;
});

describe("guardrail interceptor (universal supervisor seam)", () => {
  it("repetition: halts at EXACTLY max identical tool calls (overriding auto-approve)", async () => {
    const host = await boot(["--scenario", "repetition", "--count", "5"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      hooksConfig: { repetition: { max: 5 } },
    });

    await sendPrompt(host, sessionId);

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
    const host = await boot(["--scenario", "path_guard"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      hooksConfig: { pathGuard: { allowedPaths: ["src/**"] } },
    });

    await sendPrompt(host, sessionId);

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
    const host = await boot(["--scenario", "no_progress", "--count", "4"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      hooksConfig: { noProgress: { maxTurns: 4 } },
    });

    await sendPrompt(host, sessionId);

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
    const host = await boot(["--scenario", "repetition", "--count", "5"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      // No hooksConfig — every call just auto-approves via B1.
    });

    await sendPrompt(host, sessionId);

    expect(hookTrips(registry.snapshotEvents(sessionId))).toHaveLength(0);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("repetition: trips exactly once, then short-circuits every later call (hookHalted)", async () => {
    const host = await boot(["--scenario", "repetition", "--count", "7"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      hooksConfig: { repetition: { max: 5 } },
    });

    await sendPrompt(host, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    // 7 identical calls, max 5: the 5th halts; calls 6 & 7 are cancelled inline
    // by hookHalted WITHOUT a second trip — one escalation per halt.
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ rule: "repetition", disposition: "halt" });
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("halt cancels an OPEN permission deferred (no leaked deferred)", async () => {
    const host = await boot(["--scenario", "deferred_cancel", "--count", "3"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      // autoApprove OFF → the write opens a real HITL deferred (no inline allow).
      autoApprovePermissions: false,
      hooksConfig: { noProgress: { maxTurns: 3 } },
    });

    // Resolves ONLY because the no_progress halt cancels the open deferred (the
    // mock awaits it); a leak would hang the prompt past the test timeout.
    await sendPrompt(host, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      rule: "no_progress",
      disposition: "halt",
    });
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("no_progress: a write turn resets the counter (no trip below maxTurns idle)", async () => {
    const host = await boot([
      "--scenario",
      "no_progress_reset",
      "--count",
      "4",
    ]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      hooksConfig: { noProgress: { maxTurns: 4 } },
    });

    await sendPrompt(host, sessionId);

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
    const host = await boot(
      ["--scenario", "path_guard_kindonly", "--count", "2"],
      captureLogger,
    );
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      hooksConfig: { pathGuard: { allowedPaths: ["src/**"] } },
    });

    await sendPrompt(host, sessionId);

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
    const host = await boot([
      "--scenario",
      "path_guard_repeat",
      "--count",
      "6",
    ]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      hooksConfig: {
        pathGuard: { allowedPaths: ["src/**"] },
        repetition: { max: 3 },
        noProgress: { maxTurns: 15 },
      },
    });

    await sendPrompt(host, sessionId);

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
    const host = await boot([
      "--scenario",
      "path_guard_repeat",
      "--count",
      "6",
    ]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      // No repetition armed → only the deny-branch no_progress tick can halt a
      // stream of denied writes (proves the tick fires independently).
      hooksConfig: {
        pathGuard: { allowedPaths: ["src/**"] },
        noProgress: { maxTurns: 4 },
      },
    });

    await sendPrompt(host, sessionId);

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

describe("capability_guard interceptor (ADR-130)", () => {
  const toolsProfile = {
    tools: { allow: ["Read"] },
    enforcedClasses: ["tools"],
    escalationThreshold: 3,
  };

  it("in-profile: auto-allows inline (zero HITL) even with autoApprove OFF", async () => {
    const host = await boot(["--scenario", "capability_allow"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      // autoApprove OFF → the ONLY way this in-profile call resolves without a
      // hanging HITL deferred is capability_guard's inline auto-allow.
      autoApprovePermissions: false,
      enforcementProfile: toolsProfile,
    });

    await sendPrompt(host, sessionId);

    expect(hookTrips(registry.snapshotEvents(sessionId))).toHaveLength(0);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("out-of-profile: denies at the seam (wins over B1 auto-approve), run continues", async () => {
    const host = await boot(["--scenario", "capability_deny"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      // autoApprove ON → if capability_guard did NOT run before B1, this would
      // auto-approve with no trip. The deny trip proves the before-B1 ordering.
      autoApprovePermissions: true,
      enforcementProfile: toolsProfile,
    });

    await sendPrompt(host, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      rule: "capability_guard",
      lifecycle: "pre_tool_call",
      disposition: "deny",
    });
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("out-of-profile MCP server: denied by the mcps allow-list", async () => {
    const host = await boot(["--scenario", "capability_deny_mcp"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      enforcementProfile: {
        mcps: { allowServers: ["github"] },
        enforcedClasses: ["mcps"],
        escalationThreshold: 3,
      },
    });

    await sendPrompt(host, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      rule: "capability_guard",
      disposition: "deny",
    });
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("breaker: the Nth consecutive out-of-profile deny halts (once)", async () => {
    const host = await boot([
      "--scenario",
      "capability_deny_repeat",
      "--count",
      "5",
    ]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      enforcementProfile: toolsProfile, // escalationThreshold 3
    });

    await sendPrompt(host, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));
    const halts = trips.filter((t) => t.disposition === "halt");
    const denies = trips.filter((t) => t.disposition === "deny");

    // 5 denials, threshold 3: denies 1 & 2 continue, the 3rd halts; calls 4 & 5
    // are cancelled inline by hookHalted with no further trips.
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ rule: "capability_guard" });
    expect(denies).toHaveLength(2);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("D5 sentinel: a WRITE that executes without reaching the seam halts", async () => {
    const host = await boot(["--scenario", "capability_sentinel"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      enforcementProfile: toolsProfile,
    });

    await sendPrompt(host, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));

    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      rule: "capability_guard",
      disposition: "halt",
    });
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("D5 sentinel: an ARBITRATED write (streamed pending → requestPermission → execution) does NOT halt", async () => {
    // Regression for the pending-notification false-halt: the claude adapter
    // streams the pending tool_call BEFORE requestPermission, so keying the
    // sentinel off the pending event halted every legitimate write on its first.
    const host = await boot(["--scenario", "capability_arbitrated_write"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      // "Edit" is in-profile, so capability_guard auto-allows the write AND the
      // sentinel must not fire → zero trips.
      enforcementProfile: {
        tools: { allow: ["Edit"] },
        enforcedClasses: ["tools"],
        escalationThreshold: 3,
      },
    });

    await sendPrompt(host, sessionId);

    expect(hookTrips(registry.snapshotEvents(sessionId))).toHaveLength(0);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("anti-evasion: an ungoverned pass_through between denies does NOT reset the breaker (REQ-8)", async () => {
    const host = await boot(["--scenario", "capability_passthrough_no_reset"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      // mcps-strict: a non-MCP call (WebFetch) is ungoverned → pass_through, which
      // must NOT reset capabilityDenyCount. autoApprove ON so the pass_through
      // resolves via B1 without a hanging deferred.
      autoApprovePermissions: true,
      enforcementProfile: {
        mcps: { allowServers: ["github"] },
        enforcedClasses: ["mcps"],
        escalationThreshold: 3,
      },
    });

    await sendPrompt(host, sessionId);

    const trips = hookTrips(registry.snapshotEvents(sessionId));
    const halts = trips.filter((t) => t.disposition === "halt");
    const denies = trips.filter((t) => t.disposition === "deny");

    // deny, deny, [pass_through — no reset], deny → the 3rd deny reaches threshold 3
    // and halts. If the pass_through wrongly reset the counter, the 3rd would be
    // count 1 (no halt) → 3 denies / 0 halts. Exactly one halt proves anti-evasion.
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ rule: "capability_guard" });
    expect(denies).toHaveLength(2);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("no enforcementProfile: capability_guard is inert (auto-approves via B1)", async () => {
    const host = await boot(["--scenario", "capability_deny"]);
    const { registry, runtimeRoot } = host;
    const sessionId = await createSession(host, {
      cwd: runtimeRoot,
      autoApprovePermissions: true,
      // No enforcementProfile → capability_guard never runs.
    });

    await sendPrompt(host, sessionId);

    expect(hookTrips(registry.snapshotEvents(sessionId))).toHaveLength(0);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });
});
