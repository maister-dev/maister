import type { AcpSessionState } from "@/lib/flows/types";

import { describe, expect, it, vi } from "vitest";

import { cleanupSlashSession } from "@/lib/flows/graph/runner-core";

// Deferred-release contract (M11a plan task 3.6). The graph runner calls
// `cleanupSlashSession(sessionState, opts.supervisorApi?.deleteSession)` on
// EVERY terminal/pause exit — including the mid-node action-failure break
// (runner-graph.ts: `catch { … break }` → terminal cleanup). This guards the
// release primitive so a failed node never leaks a slash-in-existing
// supervisor session (no hidden deferreds).
describe("cleanupSlashSession — deferred-release contract", () => {
  it("releases an active session exactly once and clears the handle", async () => {
    const sessionState: AcpSessionState = {
      currentSessionId: "sess-123",
      lastSeenMonotonicId: 0,
    };
    const deleteSession = vi.fn().mockResolvedValue(undefined);

    await cleanupSlashSession(sessionState, deleteSession);

    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith("sess-123");
    // Handle cleared so a retried/duplicate cleanup cannot double-delete.
    expect(sessionState.currentSessionId).toBeNull();

    await cleanupSlashSession(sessionState, deleteSession);
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no slash-in-existing session is active", async () => {
    const sessionState: AcpSessionState = {
      currentSessionId: null,
      lastSeenMonotonicId: 0,
    };
    const deleteSession = vi.fn().mockResolvedValue(undefined);

    await cleanupSlashSession(sessionState, deleteSession);

    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("swallows a deleteSession failure so the terminal path is not derailed", async () => {
    const sessionState: AcpSessionState = {
      currentSessionId: "sess-err",
      lastSeenMonotonicId: 0,
    };
    const deleteSession = vi
      .fn()
      .mockRejectedValue(new Error("supervisor gone"));

    await expect(
      cleanupSlashSession(sessionState, deleteSession),
    ).resolves.toBeUndefined();
    expect(deleteSession).toHaveBeenCalledTimes(1);
    // Still cleared even when the release call rejected.
    expect(sessionState.currentSessionId).toBeNull();
  });
});
