import type { DeliveryDto } from "@/lib/webhooks/subscriptions";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { DeliveriesDrawer } from "@/components/webhooks/deliveries-drawer";

const deliveredRow: DeliveryDto = {
  id: "del-delivered",
  eventId: "evt-1",
  type: "run.done",
  status: "delivered",
  attemptCount: 2,
  nextAttemptAt: null,
  lastHttpStatus: 200,
  lastErrorKind: null,
  deliveredAt: new Date("2026-06-02T00:00:00Z"),
  createdAt: new Date("2026-06-01T00:00:00Z"),
  attempts: [
    {
      attemptNo: 1,
      requestedAt: new Date("2026-06-01T00:00:00Z"),
      durationMs: 412,
      httpStatus: 500,
      errorKind: "http",
      responseSnippet: "upstream boom",
    },
    {
      attemptNo: 2,
      requestedAt: new Date("2026-06-01T00:05:00Z"),
      durationMs: 121,
      httpStatus: 200,
      errorKind: null,
      responseSnippet: "ok",
    },
  ],
};

const pendingRow: DeliveryDto = {
  id: "del-pending",
  eventId: "evt-2",
  type: "hitl.requested",
  status: "pending",
  attemptCount: 1,
  nextAttemptAt: new Date("2026-06-03T00:00:00Z"),
  lastHttpStatus: null,
  lastErrorKind: "timeout",
  deliveredAt: null,
  createdAt: new Date("2026-06-01T00:00:00Z"),
  attempts: [
    {
      attemptNo: 1,
      requestedAt: new Date("2026-06-01T00:00:00Z"),
      durationMs: 10000,
      httpStatus: null,
      errorKind: "timeout",
      responseSnippet: null,
    },
  ],
};

describe("DeliveriesDrawer", () => {
  it("renders a delivery row, its attempts, and a Replay button on a delivered row", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliveriesDrawer, {
        deliveries: [deliveredRow],
        canWrite: true,
        onReplay() {},
        onClose() {},
      }),
    );

    expect(markup).toContain("deliveriesTitle");
    // Delivery summary: status label + event type.
    expect(markup).toContain("deliveryStatus.delivered");
    expect(markup).toContain("run.done");

    // Attempt history columns + a resolved error-kind label + a snippet.
    expect(markup).toContain("attemptNo");
    expect(markup).toContain("attemptHttpStatus");
    expect(markup).toContain("errorKind.http");
    expect(markup).toContain("upstream boom");

    // Replay button present on the delivered (terminal) row.
    expect(markup).toContain("replayAction");
  });

  it("does NOT offer Replay on a pending delivery", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliveriesDrawer, {
        deliveries: [pendingRow],
        canWrite: true,
        onReplay() {},
        onClose() {},
      }),
    );

    expect(markup).toContain("deliveryStatus.pending");
    expect(markup).not.toContain("replayAction");
  });

  it("hides Replay when canWrite is false even on a delivered row", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliveriesDrawer, {
        deliveries: [deliveredRow],
        canWrite: false,
        onReplay() {},
        onClose() {},
      }),
    );

    expect(markup).not.toContain("replayAction");
  });

  it("surfaces a ping result inline when provided", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliveriesDrawer, {
        deliveries: [],
        canWrite: true,
        onReplay() {},
        onClose() {},
        pingResult: { ok: true, httpStatus: 204 },
      }),
    );

    expect(markup).toContain("pingOk");
    expect(markup).toContain("deliveriesEmpty");
  });
});
