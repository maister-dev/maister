// TRC-01 / EDGE-TRC-01: what the artifact projector is allowed to derive.
//
// The Evidence plane answers "what did this run PRODUCE that a gate or a
// reviewer consumes". Tool activity is not that — it is already carried, more
// richly, by the Trace plane (`run_messages`), which keeps the tool's name,
// kind, status, arguments and result. A derived `log` artifact holds only
// `title · toolCallId · status`, so it is a strictly lossier duplicate that
// nonetheless dominates the evidence graph: on one install, 10 231 of 10 632
// artifact rows (96.2%) were projector logs.
//
// The rule pinned here: a tool surface derives an artifact only when it carries
// something a reviewer can actually open — an http(s) preview URL.

import type { ExecutionEvent } from "@/lib/db/schema";

import { beforeEach, describe, expect, it, vi } from "vitest";

const recordArtifact = vi.fn(
  async (_row: Record<string, unknown>, _tx?: unknown) => undefined,
);

// The projector reads BOTH of these at import time. A partial factory would
// fail the whole file as a SKIP rather than as an assertion
// (memory:module-scope-calls-break-mocked-suites).
vi.mock("@/lib/flows/graph/artifact-store", () => ({
  recordArtifact,
  canonicalProjectorArtifactId: ({
    runId,
    eventId,
  }: {
    runId: string;
    eventId: string;
  }) => `proj:${runId}:event:${eventId}`,
}));

const { canonicalArtifactProjector } = await import(
  "@/lib/projector/artifact-projector"
);

// `nodeAttemptId: null` keeps attribution out of the transaction entirely, so
// these stay unit tests: `canonicalAttribution` returns before touching `tx`.
const tx = {} as never;

function event(
  eventType: "session.update" | "session.permission_request",
  payload: Record<string, unknown>,
  id = "event-1",
): ExecutionEvent {
  return {
    id,
    source: "host",
    runId: "run-1",
    eventType,
    payloadSchema: "maister.session.update.v1",
    payload: { nodeAttemptId: null, ...payload },
  } as unknown as ExecutionEvent;
}

const PREVIEW_URL = "https://preview.example.test/build/42";

function toolCall(extra: Record<string, unknown> = {}) {
  return {
    toolCallId: "tool-1",
    title: "Run check",
    status: "completed",
    ...extra,
  };
}

function resourceLink(uri: string) {
  return [{ type: "resource_link", uri, name: "preview" }];
}

describe("artifact derivation", () => {
  beforeEach(() => {
    recordArtifact.mockClear();
  });

  // UT-TRC-01
  it.each(["tool_call", "tool_call_update"] as const)(
    "UT-TRC-01: derives nothing from a %s with no preview URL",
    async (sessionUpdate) => {
      await canonicalArtifactProjector.project(
        tx,
        event("session.update", {
          update: { sessionUpdate, ...toolCall({ content: [] }) },
        }),
      );

      expect(recordArtifact).not.toHaveBeenCalled();
    },
  );

  // UT-TRC-01: a local path, a bare filename and a URL under a non-locator key
  // are all "no preview" — the old code turned each of them into a log row.
  it.each([
    ["locations with a repo path", { locations: [{ path: "web/lib/db.ts" }] }],
    ["a file:// resource link", { content: resourceLink("file:///tmp/out") }],
    ["a URL in free text", { content: [{ type: "text", text: PREVIEW_URL }] }],
    ["a raw command string", { rawInput: { command: "pnpm lint" } }],
  ])(
    "UT-TRC-01: derives nothing from a tool call with %s",
    async (_n, extra) => {
      await canonicalArtifactProjector.project(
        tx,
        event("session.update", {
          update: { sessionUpdate: "tool_call", ...toolCall(extra) },
        }),
      );

      expect(recordArtifact).not.toHaveBeenCalled();
    },
  );

  it("UT-TRC-01: still derives a preview when the tool surface carries one", async () => {
    await canonicalArtifactProjector.project(
      tx,
      event("session.update", {
        update: {
          sessionUpdate: "tool_call",
          ...toolCall({ content: resourceLink(PREVIEW_URL) }),
        },
      }),
    );

    expect(recordArtifact).toHaveBeenCalledTimes(1);
    expect(recordArtifact.mock.calls[0][0]).toMatchObject({
      kind: "preview",
      uri: PREVIEW_URL,
      producer: "projector",
      artifactDefId: null,
    });
  });

  // EDGE-TRC-01: a permission request carries its tool surface under `toolCall`
  // with NO `sessionUpdate` discriminant, so it reaches the same classifier by a
  // different door. It must obey the same rule at both ends.
  it("UT-EDGE-TRC-01: a permission request derives a preview with a URL and nothing without", async () => {
    await canonicalArtifactProjector.project(
      tx,
      event("session.permission_request", {
        toolCall: toolCall({ content: resourceLink(PREVIEW_URL) }),
      }),
    );

    expect(recordArtifact).toHaveBeenCalledTimes(1);
    expect(recordArtifact.mock.calls[0][0]).toMatchObject({
      kind: "preview",
      uri: PREVIEW_URL,
    });

    recordArtifact.mockClear();

    await canonicalArtifactProjector.project(
      tx,
      event("session.permission_request", {
        toolCall: toolCall({ content: [] }),
      }),
    );

    expect(recordArtifact).not.toHaveBeenCalled();
  });

  // The one-derivation invariant, replayed over a realistic turn. `TRC` was
  // planned against a reported 1.86x artifact:event ratio; that ratio was a
  // measurement artifact (the counting query keyed on a `sessionUpdate` field
  // that is NULL for every offloaded payload). If this ever shows MORE
  // artifacts than events, D1 is built on a false premise and must be replanned.
  it("derives at most one artifact per event across a realistic turn", async () => {
    const turn: ExecutionEvent[] = [
      event(
        "session.update",
        { update: { sessionUpdate: "user_message_chunk" } },
        "e1",
      ),
      event(
        "session.update",
        { update: { sessionUpdate: "agent_thought_chunk" } },
        "e2",
      ),
      event(
        "session.update",
        {
          update: { sessionUpdate: "tool_call", ...toolCall({ content: [] }) },
        },
        "e3",
      ),
      event(
        "session.update",
        {
          update: {
            sessionUpdate: "tool_call_update",
            ...toolCall({ status: "in_progress", content: [] }),
          },
        },
        "e4",
      ),
      event(
        "session.update",
        {
          update: {
            sessionUpdate: "tool_call_update",
            ...toolCall({ content: [] }),
          },
        },
        "e5",
      ),
      event(
        "session.permission_request",
        { toolCall: toolCall({ content: [] }) },
        "e6",
      ),
      event(
        "session.update",
        { update: { sessionUpdate: "agent_message_chunk" } },
        "e7",
      ),
      event(
        "session.update",
        { update: { sessionUpdate: "usage_update" } },
        "e8",
      ),
      event(
        "session.update",
        {
          update: {
            sessionUpdate: "tool_call",
            ...toolCall({ content: resourceLink(PREVIEW_URL) }),
          },
        },
        "e9",
      ),
    ];

    for (const frame of turn) {
      await canonicalArtifactProjector.project(tx, frame);
    }

    expect(recordArtifact.mock.calls.length).toBeLessThanOrEqual(turn.length);
    // Exactly one surface in that turn is openable by a reviewer.
    expect(recordArtifact).toHaveBeenCalledTimes(1);
  });
});
