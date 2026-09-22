// ADR-180: graceful shutdown must not race its own SIGKILL.
//
// `stopSession` called `pendingPermissions.purgeSession` — a REJECT — before
// marking the shutdown intentional and sending SIGTERM. A rejected permission
// is a producer fault: it reaches `input.onFailure` → `abortOutput` → SIGKILL,
// so the supervisor killed the child it was in the middle of asking to exit
// politely, and stamped the prompt `required_output_incomplete`.
//
// The contract asserted here is the ORDER and the RELEASE SHAPE, both
// observable: the session is marked intentional first, every open deferred
// settles `{outcome:"cancelled"}` (journalled by the adapter for replay), and
// nothing is rejected.
import type { RegistryEntry, SessionRegistry } from "../registry";
import type { SessionRecord } from "../types";

import { EventEmitter } from "node:events";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  pendingPermissions,
  type AcpPermissionOutcome,
} from "../pending-permissions";
import { stopRegisteredSessions } from "../shutdown";
import { SupervisorError } from "../types";

const silentLogger = pino({ level: "silent" });

type Settled =
  | { kind: "resolved"; outcome: AcpPermissionOutcome }
  | { kind: "rejected"; error: Error };

type FakeChild = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
};

function makeChild(trace: string[]): FakeChild {
  const child = new EventEmitter() as FakeChild;

  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal?: NodeJS.Signals) => {
    trace.push(`kill:${signal ?? "SIGTERM"}`);
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));

    return true;
  };

  return child;
}

function makeEntry(sessionId: string, trace: string[]): RegistryEntry {
  const record = {
    sessionId,
    outputDrained: Promise.resolve(),
    outputTerminal: Promise.resolve(),
    stopOutputForTeardown: () => trace.push("stopOutput"),
  } as unknown as SessionRecord;

  return {
    record,
    child: makeChild(trace) as unknown as RegistryEntry["child"],
    emitter: new EventEmitter(),
    intentionalShutdown: false,
    eventBuffer: [],
    eventBufferBytes: 0,
  };
}

function makeRegistry(
  entries: RegistryEntry[],
  trace: string[],
): SessionRegistry {
  return {
    forEach: (fn: (entry: RegistryEntry) => void) => entries.forEach(fn),
    markIntentionalShutdown: (sessionId: string, reason?: string) => {
      trace.push(`markIntentional:${sessionId}:${reason ?? "intentional"}`);

      return true;
    },
  } as unknown as SessionRegistry;
}

function capture(sessionId: string, requestId: string): () => Settled | null {
  let settled: Settled | null = null;

  pendingPermissions.register(sessionId, requestId, {
    resolve: (outcome) => {
      settled = { kind: "resolved", outcome };
    },
    reject: (error) => {
      settled = { kind: "rejected", error };
    },
  });

  return () => settled;
}

describe("stopRegisteredSessions — graceful shutdown (ADR-180)", () => {
  it("marks the shutdown intentional before releasing any deferred, and cancels instead of rejecting", async () => {
    const trace: string[] = [];
    const entry = makeEntry("sd-1", trace);
    const registry = makeRegistry([entry], trace);
    const purge = vi.spyOn(pendingPermissions, "purgeSession");
    const first = capture("sd-1", "req-a");
    const second = capture("sd-1", "req-b");

    await stopRegisteredSessions(registry, silentLogger, 1_000);

    expect(first()).toEqual({
      kind: "resolved",
      outcome: { outcome: "cancelled" },
    });
    expect(second()).toEqual({
      kind: "resolved",
      outcome: { outcome: "cancelled" },
    });
    expect(purge).not.toHaveBeenCalled();
    expect(trace.indexOf("markIntentional:sd-1:intentional")).toBeLessThan(
      trace.indexOf("kill:SIGTERM"),
    );
    expect(trace).toContain("stopOutput");
    purge.mockRestore();
  });

  it("releases every open request of the session, not only the first", async () => {
    const trace: string[] = [];
    const entry = makeEntry("sd-2", trace);
    const registry = makeRegistry([entry], trace);
    const captures = ["r1", "r2", "r3"].map((id) => capture("sd-2", id));

    await stopRegisteredSessions(registry, silentLogger, 1_000);

    for (const settled of captures) {
      expect(settled()).toEqual({
        kind: "resolved",
        outcome: { outcome: "cancelled" },
      });
    }
    expect(pendingPermissions.size("sd-2")).toBe(0);
  });

  it("leaves an already-exited session's deferreds to the terminal path", async () => {
    const trace: string[] = [];
    const entry = makeEntry("sd-3", trace);

    (entry.child as unknown as FakeChild).exitCode = 0;
    const registry = makeRegistry([entry], trace);
    const settled = capture("sd-3", "r1");

    await stopRegisteredSessions(registry, silentLogger, 1_000);

    expect(trace).toEqual([]);
    expect(settled()).toBeNull();
    pendingPermissions.purgeSession("sd-3");
    expect((settled() as { kind: string } | null)?.kind).toBe("rejected");
    expect(
      ((settled() as { error: Error }).error as SupervisorError).code,
    ).toBe("CRASH");
  });
});
