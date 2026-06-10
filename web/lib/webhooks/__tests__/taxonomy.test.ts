import { describe, expect, it } from "vitest";

import {
  WEBHOOK_API_VERSION,
  WEBHOOK_EVENT_TYPES,
  buildEnvelopePayload,
  finalizeEnvelope,
  isWebhookEventType,
  type WebhookEnvelopePayload,
  type WebhookEventType,
  type WebhookProjectRef,
  type WebhookRunRef,
} from "@/lib/webhooks/taxonomy";

// =============================================================================
// T4 — outbound-webhooks taxonomy (TDD red).
//
// Pins the envelope-v1 contract from docs/system-analytics/outbound-webhooks.md
// (Event taxonomy v1 + Envelope v1) and docs/api/async/outbound-webhooks.asyncapi.yaml
// (per-type `data` shapes). Module `@/lib/webhooks/taxonomy` does not exist yet —
// these MUST fail with module-not-found until the implementor lands it verbatim.
// =============================================================================

const EXPECTED_TYPES = [
  "run.started",
  "run.needs_input",
  "hitl.requested",
  "hitl.responded",
  "run.review",
  "run.promoted",
  "run.done",
  "run.failed",
  "run.crashed",
  "run.abandoned",
  "gate.decided",
  "ping",
] as const;

const PROJECT: WebhookProjectRef = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "my-app",
  name: "My App",
};

const RUN: WebhookRunRef = {
  id: "22222222-2222-4222-8222-222222222222",
  taskId: "33333333-3333-4333-8333-333333333333",
  flowId: "bugfix",
  branch: "maister/bugfix-1042",
  status: "Review",
};

describe("WEBHOOK_API_VERSION", () => {
  it("is the literal 1", () => {
    expect(WEBHOOK_API_VERSION).toBe(1);
  });
});

describe("WEBHOOK_EVENT_TYPES", () => {
  it("has exactly the 12 listed types in order", () => {
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(12);
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([...EXPECTED_TYPES]);
  });

  it("contains no duplicates", () => {
    expect(new Set(WEBHOOK_EVENT_TYPES).size).toBe(WEBHOOK_EVENT_TYPES.length);
  });
});

describe("isWebhookEventType", () => {
  it("returns true for each of the 12 canonical types", () => {
    for (const type of EXPECTED_TYPES) {
      expect(isWebhookEventType(type)).toBe(true);
    }
  });

  it("returns false for junk and empty strings", () => {
    expect(isWebhookEventType("run.foo")).toBe(false);
    expect(isWebhookEventType("")).toBe(false);
    expect(isWebhookEventType("RUN.STARTED")).toBe(false);
    expect(isWebhookEventType("ping ")).toBe(false);
    expect(isWebhookEventType("hitl_requested")).toBe(false);
  });
});

describe("buildEnvelopePayload", () => {
  it("sets apiVersion=1 and copies id/type/data/project/run", () => {
    const data = { source: "runner" };
    const payload = buildEnvelopePayload({
      eventId: "evt_8a4a7b9d0d6b4b27",
      type: "run.review",
      occurredAt: "2026-06-10T12:30:04Z",
      data,
      project: PROJECT,
      run: RUN,
    });

    expect(payload.apiVersion).toBe(1);
    expect(payload.id).toBe("evt_8a4a7b9d0d6b4b27");
    expect(payload.type).toBe("run.review");
    expect(payload.data).toEqual(data);
    expect(payload.project).toEqual(PROJECT);
    expect(payload.run).toEqual(RUN);
  });

  it("normalizes a Date occurredAt to an ISO-8601 UTC string", () => {
    const payload = buildEnvelopePayload({
      eventId: "evt_date",
      type: "run.done",
      occurredAt: new Date("2026-06-10T10:00:00Z"),
      data: {},
      project: PROJECT,
      run: RUN,
    });

    expect(payload.occurredAt).toBe("2026-06-10T10:00:00.000Z");
  });

  it("normalizes a string occurredAt to an ISO-8601 UTC string", () => {
    const payload = buildEnvelopePayload({
      eventId: "evt_str",
      type: "run.done",
      occurredAt: "2026-06-10T10:00:00Z",
      data: {},
      project: PROJECT,
      run: RUN,
    });

    expect(payload.occurredAt).toBe("2026-06-10T10:00:00.000Z");
  });

  it("normalizes a non-UTC offset string to UTC", () => {
    const payload = buildEnvelopePayload({
      eventId: "evt_off",
      type: "run.done",
      occurredAt: "2026-06-10T13:00:00+03:00",
      data: {},
      project: PROJECT,
      run: RUN,
    });

    expect(payload.occurredAt).toBe("2026-06-10T10:00:00.000Z");
  });

  it("allows a ping payload to carry project:null and run:null", () => {
    const payload = buildEnvelopePayload({
      eventId: "evt_ping_0f1e2d3c4b5a",
      type: "ping",
      occurredAt: "2026-06-10T12:33:20Z",
      data: { message: "MAIster webhook ping" },
      project: null,
      run: null,
    });

    expect(payload.project).toBeNull();
    expect(payload.run).toBeNull();
    expect(payload.type).toBe("ping");
    expect(payload.data).toEqual({ message: "MAIster webhook ping" });
  });

  it("does NOT carry deliveryId or attempt (those are send-time only)", () => {
    const payload = buildEnvelopePayload({
      eventId: "evt_no_delivery",
      type: "run.review",
      occurredAt: "2026-06-10T12:30:04Z",
      data: { source: "runner" },
      project: PROJECT,
      run: RUN,
    });

    expect(payload).not.toHaveProperty("deliveryId");
    expect(payload).not.toHaveProperty("attempt");
  });
});

describe("buildEnvelopePayload — per-type data shapes pass through unchanged", () => {
  // One representative `data` object per type, taken verbatim from the
  // asyncapi per-type `data` schemas. Each must round-trip byte-for-byte.
  const cases: ReadonlyArray<{
    type: WebhookEventType;
    data: Record<string, unknown>;
  }> = [
    { type: "run.started", data: { trigger: "direct" } },
    {
      type: "run.needs_input",
      data: { reason: "human_review", nodeId: "review" },
    },
    {
      type: "hitl.requested",
      data: {
        hitlRequestId: "44444444-4444-4444-8444-444444444444",
        kind: "human_review",
        nodeId: "review",
      },
    },
    {
      type: "hitl.responded",
      data: {
        hitlRequestId: "44444444-4444-4444-8444-444444444444",
        kind: "human_review",
        via: "user",
      },
    },
    { type: "run.review", data: { source: "runner" } },
    {
      type: "run.promoted",
      data: { mode: "local_merge", target: "main", pullRequestUrl: null },
    },
    { type: "run.done", data: {} },
    { type: "run.failed", data: { errorCode: "CONFIG" } },
    { type: "run.crashed", data: { errorCode: null } },
    { type: "run.abandoned", data: { source: "user" } },
    {
      type: "gate.decided",
      data: {
        gateId: "tests-pass",
        kind: "command_check",
        mode: "blocking",
        status: "failed",
        nodeAttemptId: "55555555-5555-4555-8555-555555555555",
      },
    },
    { type: "ping", data: { message: "MAIster webhook ping" } },
  ];

  it("covers all 12 types in the table", () => {
    expect(cases.map((c) => c.type)).toEqual([...EXPECTED_TYPES]);
  });

  for (const { type, data } of cases) {
    it(`passes ${type} data through unchanged`, () => {
      const payload = buildEnvelopePayload({
        eventId: `evt_${type}`,
        type,
        occurredAt: "2026-06-10T12:30:04Z",
        data,
        project: type === "ping" ? null : PROJECT,
        run: type === "ping" ? null : RUN,
      });

      expect(payload.data).toEqual(data);
      expect(payload.type).toBe(type);
    });
  }
});

describe("finalizeEnvelope", () => {
  function basePayload(): WebhookEnvelopePayload {
    return buildEnvelopePayload({
      eventId: "evt_8a4a7b9d0d6b4b27",
      type: "run.review",
      occurredAt: "2026-06-10T12:30:04Z",
      data: { source: "runner" },
      project: PROJECT,
      run: RUN,
    });
  }

  it("returns {...payload, deliveryId, attempt}", () => {
    const payload = basePayload();
    const envelope = finalizeEnvelope(payload, "del_9a4a7b9d0d6b4b27", 2);

    expect(envelope.deliveryId).toBe("del_9a4a7b9d0d6b4b27");
    expect(envelope.attempt).toBe(2);
    // every payload key is preserved on the wire envelope.
    expect(envelope.apiVersion).toBe(1);
    expect(envelope.id).toBe(payload.id);
    expect(envelope.type).toBe(payload.type);
    expect(envelope.occurredAt).toBe(payload.occurredAt);
    expect(envelope.project).toEqual(payload.project);
    expect(envelope.run).toEqual(payload.run);
    expect(envelope.data).toEqual(payload.data);
  });

  it("does NOT mutate the input payload (frozen reuse across retries)", () => {
    const payload = basePayload();
    const snapshot = JSON.parse(JSON.stringify(payload));

    finalizeEnvelope(payload, "del_first", 1);
    finalizeEnvelope(payload, "del_second", 3);

    expect(payload).toEqual(snapshot);
    expect(payload).not.toHaveProperty("deliveryId");
    expect(payload).not.toHaveProperty("attempt");
  });

  it("produces distinct envelopes from the same frozen payload (only deliveryId/attempt differ)", () => {
    const payload = basePayload();
    const first = finalizeEnvelope(payload, "del_a", 1);
    const second = finalizeEnvelope(payload, "del_b", 2);

    expect(first.deliveryId).toBe("del_a");
    expect(first.attempt).toBe(1);
    expect(second.deliveryId).toBe("del_b");
    expect(second.attempt).toBe(2);
    // the envelope bodies are otherwise byte-identical (same id/type/data).
    expect(first.id).toBe(second.id);
    expect(first.data).toEqual(second.data);
  });

  it("carries the ping null project/run through to the wire envelope", () => {
    const payload = buildEnvelopePayload({
      eventId: "evt_ping_0f1e2d3c4b5a",
      type: "ping",
      occurredAt: "2026-06-10T12:33:20Z",
      data: { message: "MAIster webhook ping" },
      project: null,
      run: null,
    });
    const envelope = finalizeEnvelope(payload, "del_ping_0f1e2d3c4b5a", 1);

    expect(envelope.project).toBeNull();
    expect(envelope.run).toBeNull();
    expect(envelope.deliveryId).toBe("del_ping_0f1e2d3c4b5a");
    expect(envelope.attempt).toBe(1);
  });
});
