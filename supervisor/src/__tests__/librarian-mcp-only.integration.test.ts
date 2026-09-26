// ADR-183 D5 (IT-LAU-11): a librarian turn is MCP-only. The web sends an
// enforcement profile that admits exactly the maister facade's librarian tools;
// capability_guard denies every built-in (file, shell, web) inline, admits the
// facade tool without a HITL deferred, and halts the session on the third
// consecutive denial. The mock scripts the calls; the assertions read the
// supervisor's own hook-trip events.

import type { SessionEvent } from "../types";

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

const RUN_ID = "run-librarian";

// The shape `web/lib/librarian/session-profile.ts` builds (tools.allow is the
// whole librarian toolset there; one tool is enough to prove the seam here).
const LIBRARIAN_PROFILE = {
  tools: { allow: ["mcp__maister__task_get", "mcp__maister__task_search"] },
  mcps: { allowServers: ["maister"] },
  enforcedClasses: ["tools", "mcps"],
  escalationThreshold: 3,
};

let booted: BootedHost | null = null;

async function runScenario(scenario: string): Promise<{
  host: BootedHost;
  sessionId: string;
}> {
  booted = await bootHost({
    fixture: "mock-acp-guardrail.mjs",
    fixtureArgs: ["--scenario", scenario],
  });
  const host = booted;
  const handle = await adoptDirectory(
    host,
    { runId: RUN_ID },
    { dir: host.runtimeRoot },
  );
  const created = await postJson(
    `${host.url}/sessions`,
    envelope(
      "session.create",
      fenceFor(host, RUN_ID),
      createBody(handle, {
        autoApprovePermissions: true,
        enforcementProfile: LIBRARIAN_PROFILE,
      }),
    ),
  );

  expect(created.status).toBe(201);
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const prompted = await completePrompt(
    host,
    sessionId,
    envelope("session.prompt", fenceFor(host, RUN_ID), {
      stepId: "librarian",
      prompt: "go",
    }),
  );

  expect(prompted.status).toBe(200);

  return { host, sessionId };
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

describe("IT-LAU-11: a librarian session reaches only the maister facade", () => {
  it("denies a built-in read and a web fetch, allows the facade tool inline", async () => {
    const { host, sessionId } = await runScenario("librarian_mcp_only");
    const trips = hookTrips(host.registry.snapshotEvents(sessionId));

    // Two denials (Read, WebFetch); the facade call produced no trip at all,
    // and no permission deferred was left for a human to answer.
    expect(trips).toHaveLength(2);
    expect(trips.every((t) => t.rule === "capability_guard")).toBe(true);
    expect(trips.every((t) => t.disposition === "deny")).toBe(true);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });

  it("halts the session on the third consecutive built-in call", async () => {
    const { host, sessionId } = await runScenario("librarian_builtin_repeat");
    const trips = hookTrips(host.registry.snapshotEvents(sessionId));
    const halts = trips.filter((t) => t.disposition === "halt");

    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ rule: "capability_guard" });
    expect(trips.filter((t) => t.disposition === "deny")).toHaveLength(2);
    expect(pendingPermissions.size(sessionId)).toBe(0);
  });
});

describe("ADR-183: the reserved librarian workspace slug", () => {
  it("adopts a directory under `_librarian` and refuses other non-kebab slugs", async () => {
    booted = await bootHost({
      fixture: "mock-acp-guardrail.mjs",
      fixtureArgs: ["--scenario", "librarian_mcp_only"],
    });
    const host = booted;
    const adopt = (projectSlug: string) =>
      postJson(
        `${host.url}/workspaces/adopt`,
        envelope("workspace.adopt", fenceFor(host, RUN_ID), {
          runId: RUN_ID,
          projectSlug,
          kind: "directory",
          path: host.runtimeRoot,
        }),
      );

    const refused = await adopt("_other");

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "PRECONDITION",
      message: expect.stringContaining("projectSlug"),
    });
    expect((await adopt("_librarian")).status).toBe(200);
  });
});
