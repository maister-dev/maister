// Interrupt route: POST /sessions/:id/cancel sends a protocol-level
// session/cancel without tearing the session down. Unit-level coverage of the
// 404 path, the idempotent no-live-turn ack, and the live-session path (cancel
// notification fired + pending permissions released + cancelRequested flag set).
import type { ChildProcess } from "node:child_process";

import { EventEmitter } from "node:events";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pendingPermissions } from "../pending-permissions";
import { SessionRegistry } from "../registry";

import {
  bootHost,
  cleanupRuntimeRoot,
  envelope,
  fenceFor,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

function makeFakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

function bootBare(): Promise<BootedHost> {
  return bootHost({ killGraceMs: 250 });
}

// The registered fake records carry `runId: run-<sessionId>`; a fence must
// name that run for the command to reach the route's own checks.
function command(
  kind: "session.input" | "session.cancel" | "session.checkpoint",
  sessionId: string,
  payload: Record<string, unknown> = {},
) {
  return envelope(kind, fenceFor(booted!, `run-${sessionId}`), payload);
}

async function registerSession(
  registry: SessionRegistry,
  runtimeRoot: string,
  sessionId: string,
  opts: {
    status: "live" | "exited";
    connection?: { cancel: ReturnType<typeof vi.fn> };
    acpSessionId?: string;
  },
): Promise<void> {
  const emitter = new EventEmitter();
  registry.register(
    {
      sessionId,
      adapter: "claude",
      runId: `run-${sessionId}`,
      projectSlug: "demo",
      stepId: "step-1",
      sessionName: "default",
      status: opts.status,
      pid: 1,
      startedAt: new Date().toISOString(),
      logPath: join(runtimeRoot, "log"),
      worktreePath: join(runtimeRoot, "wt"),
      executionWorkspaceId: "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
      assignmentId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
      assignmentEpoch: 1,
      createdByCommandId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
      monotonicId: 1,
    },
    makeFakeChild(),
    emitter,
    {
      connection: opts.connection as never,
      acpSessionId: opts.acpSessionId,
    },
  );
}

let booted: BootedHost | null = null;

beforeEach(() => {
  booted = null;
});

afterEach(async () => {
  if (booted) {
    for (const entry of booted.registry.list()) {
      pendingPermissions.purgeSession(entry.sessionId);
    }
    await booted.stop();
    await cleanupRuntimeRoot(booted.runtimeRoot);
    booted = null;
  }
});

describe("POST /sessions/:id/cancel", () => {
  it("returns 404 for an unknown session", async () => {
    booted = await bootBare();
    const res = await postJson(
      `${booted.url}/sessions/missing/cancel`,
      command("session.cancel", "missing"),
    );

    expect(res.status).toBe(404);
  });

  it("acks cancelled:false for a session with no live turn", async () => {
    booted = await bootBare();
    const sessionId = "00000000-0000-4000-8000-000000000001";
    await registerSession(booted.registry, booted.runtimeRoot, sessionId, {
      status: "exited",
    });

    const res = await postJson(
      `${booted.url}/sessions/${sessionId}/cancel`,
      command("session.cancel", sessionId),
    );

    expect(res.status).toBe(200);
    expect(res.body as { cancelled: boolean }).toMatchObject({
      cancelled: false,
    });
  });

  it("fires session/cancel, releases pending permissions, and flags the record on a live session", async () => {
    booted = await bootBare();
    const cancel = vi.fn().mockResolvedValue(undefined);

    const sessionId = "00000000-0000-4000-8000-000000000002";
    await registerSession(booted.registry, booted.runtimeRoot, sessionId, {
      status: "live",
      connection: { cancel },
      acpSessionId: "acp-1",
    });

    let cancelledReason: string | null = null;

    pendingPermissions.register(
      sessionId,
      "00000000-0000-0000-0000-000000000001",
      {
        resolve: (outcome) => {
          cancelledReason = (outcome as { outcome?: string }).outcome ?? null;
        },
        reject: () => undefined,
      },
    );

    const res = await postJson(
      `${booted.url}/sessions/${sessionId}/cancel`,
      command("session.cancel", sessionId),
    );

    expect(res.status).toBe(200);
    expect(res.body as { cancelled: boolean }).toMatchObject({
      cancelled: true,
    });
    expect(cancel).toHaveBeenCalledWith({ sessionId: "acp-1" });
    expect(cancelledReason).toBe("cancelled");
    expect(booted.registry.get(sessionId)?.record.cancelRequested).toBe(true);
  });
});
