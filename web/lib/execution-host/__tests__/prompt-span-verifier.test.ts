// ADR-167 D5 amendment (2026-09-23), D-B4: one verifier walks a command's
// event span whether the canonical feed or the host's span pages it. Each case
// is one refusal cause over synthetic pages; the feeds differ only in where
// the pages come from.
import type { ExecutionCommand, ExecutionEvent } from "@/lib/db/schema";
import type { ExecutionHostTransport } from "@/lib/execution-host/contracts";
import type { CommandOutputManifestV2 } from "../../../../runtime/command-evidence";

import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { commandEvents } = await import("@/lib/execution-host/prompt-output");

const STREAM = "stream-row";
const SESSION = "host-session-1";
const command = {
  id: randomUUID(),
  runId: "run-1",
  executionHostId: "host-1",
  executionAssignmentId: "assignment-1",
  assignmentEpoch: 1,
} as ExecutionCommand;
const manifest = {
  hostSessionId: SESSION,
  acceptedSequence: "10",
  terminalSequence: "13",
} as CommandOutputManifestV2;
const TERMINAL = "terminal-event";

function event(
  sequence: number,
  overrides: Partial<ExecutionEvent> = {},
): ExecutionEvent {
  return {
    id: sequence === 13 ? TERMINAL : `event-${sequence}`,
    source: "host",
    runId: command.runId,
    executionHostId: command.executionHostId,
    eventStreamId: STREAM,
    hostSequence: BigInt(sequence),
    executionAssignmentId: command.executionAssignmentId,
    assignmentEpoch: command.assignmentEpoch,
    hostSessionId: SESSION,
    eventType: sequence === 13 ? "session.command" : "session.update",
    payloadSchema: "maister.session.update.v1",
    payload: { sourceCommandId: command.id, sourceMonotonicId: sequence },
    payloadBytes: 64,
    ingestDisposition: "accepted",
    ...overrides,
  } as ExecutionEvent;
}

async function* pages(
  ...batches: ExecutionEvent[][]
): AsyncGenerator<ExecutionEvent[]> {
  for (const batch of batches) yield batch;
}

async function verify(
  batches: ExecutionEvent[][],
  transport = {} as ExecutionHostTransport,
): Promise<ExecutionEvent[]> {
  const out: ExecutionEvent[] = [];

  for await (const verified of commandEvents({
    command,
    manifest,
    terminalEventId: TERMINAL,
    pages: pages(...batches),
    streamRowId: STREAM,
    transport,
    signal: AbortSignal.timeout(5_000),
  }))
    out.push(verified);

  return out;
}

function refusal(causeCode: string) {
  return expect.objectContaining({
    details: { reason: "required_output_incomplete", causeCode },
  });
}

describe("prompt span verifier", () => {
  it("yields the command's own session events across pages and consumes the terminal", async () => {
    const other = event(12, {
      hostSessionId: "another-session",
      runId: "another-run",
      executionAssignmentId: null,
      ingestDisposition: "stale_epoch",
      payload: {},
    });
    const verified = await verify([[event(11)], [other, event(13)]]);

    expect(verified.map((row) => row.hostSequence)).toEqual([11n]);
  });

  it.each([
    [
      "an oversized row",
      [[event(11, { payloadBytes: 1_048_577 })]],
      "event_size",
    ],
    ["a hole in the span", [[event(12)]], "event_span_gap"],
    [
      "a row of another stream",
      [[event(11, { eventStreamId: "foreign-stream" })]],
      "event_span_gap",
    ],
    [
      "a row still pending ingest",
      [[event(11, { ingestDisposition: "pending_gap" })]],
      "event_span_gap",
    ],
    [
      "pages ending before the terminal",
      [[event(11), event(12)]],
      "event_span_gap",
    ],
    [
      "a terminal row that is not the receipt's event",
      [[event(11), event(12), event(13, { id: "another-terminal" })]],
      "terminal_identity",
    ],
    [
      "a same-session row of another command",
      [[event(11, { payload: { sourceCommandId: randomUUID() } })]],
      "source_command_binding",
    ],
    [
      "a same-session row of another assignment",
      [[event(11, { executionAssignmentId: "assignment-2" })]],
      "source_command_binding",
    ],
  ] as const)("refuses %s", async (_name, batches, causeCode) => {
    await expect(
      verify(batches as unknown as ExecutionEvent[][]),
    ).rejects.toEqual(refusal(causeCode));
  });

  // Every row is present and the prefix is valid, so only the order check can
  // refuse: the same rows in order verify.
  it("refuses rows out of order", async () => {
    await expect(verify([[event(11), event(13), event(12)]])).rejects.toEqual(
      refusal("event_span_gap"),
    );
    await expect(
      verify([[event(11), event(12), event(13)]]),
    ).resolves.toHaveLength(2);
  });

  const bytes = new TextEncoder().encode(
    JSON.stringify({
      sourceCommandId: command.id,
      sourceMonotonicId: 11,
      sessionName: "default",
    }),
  );
  const contentRef = (overrides: Record<string, unknown> = {}) => ({
    schema: "maister.session-content.v2",
    commandId: command.id,
    hostSessionId: SESSION,
    source: "session_update",
    firstFrame: 11,
    frameCount: 1,
    objectId: randomUUID(),
    kind: "raw_transcript",
    logicalName: "session-content.json",
    mimeType: "application/json",
    generation: 1,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    retentionClass: "run",
    state: "available",
    sealedAt: "2026-09-23T12:00:00.000Z",
    expiresAt: null,
    ...overrides,
  });
  const contentEvent = (reference: Record<string, unknown>) =>
    event(11, {
      payloadSchema: "maister.session.content.v2",
      payload: {
        sourceCommandId: command.id,
        sourceMonotonicId: 11,
        sessionName: "default",
        contentRef: reference,
      },
    });
  const storage = (served: Uint8Array, reference: Record<string, unknown>) =>
    ({
      getRuntimeObject: async () => ({
        state: "available",
        generation: reference.generation,
        sizeBytes: reference.sizeBytes,
        sha256: reference.sha256,
      }),
      openRuntimeObjectContent: async () => ({
        contentRange: null,
        contentLength: served.byteLength,
        body: new Blob([served]).stream(),
      }),
    }) as unknown as ExecutionHostTransport;

  it("refuses a content reference bound to another command", async () => {
    const reference = contentRef({ commandId: randomUUID() });

    await expect(
      verify([[contentEvent(reference)]], storage(bytes, reference)),
    ).rejects.toEqual(refusal("content_binding"));
  });

  it("refuses content whose bytes do not match the reference digest", async () => {
    const reference = contentRef();
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(bytes).replace("default", "defaulX"),
    );

    await expect(
      verify([[contentEvent(reference)]], storage(tampered, reference)),
    ).rejects.toEqual(refusal("object_digest"));
  });

  it("hydrates verified content in place of the reference", async () => {
    const reference = contentRef();
    const [hydrated] = await verify(
      [[contentEvent(reference), event(12), event(13)]],
      storage(bytes, reference),
    );

    expect(hydrated.payload).toEqual({
      sourceCommandId: command.id,
      sourceMonotonicId: 11,
      sessionName: "default",
    });
  });
});
