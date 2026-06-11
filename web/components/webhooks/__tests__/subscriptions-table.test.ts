import type { WebhookSubscriptionDto } from "@/lib/webhooks/subscriptions";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { SubscriptionsTable } from "@/components/webhooks/subscriptions-table";

const platformSub: WebhookSubscriptionDto = {
  id: "sub-1",
  projectId: null,
  name: "Ops notifier",
  url: "https://hooks.example.com/ops",
  method: "POST",
  headers: {},
  event_types: ["run.done", "*"],
  signing_secret_ref: "env:WEBHOOK_SIGNING_SECRET",
  secondary_signing_secret_ref: null,
  enabled: true,
  createdAt: new Date("2026-06-01T00:00:00Z"),
  updatedAt: new Date("2026-06-01T00:00:00Z"),
  lastDelivery: { status: "delivered", at: new Date("2026-06-02T00:00:00Z") },
};

const projectSub: WebhookSubscriptionDto = {
  id: "sub-2",
  projectId: "11111111-1111-1111-1111-111111111111",
  name: "Project hook",
  url: "https://team.example.org/webhook",
  method: "PUT",
  headers: {},
  event_types: ["hitl.requested"],
  signing_secret_ref: "env:PROJECT_SECRET",
  secondary_signing_secret_ref: null,
  enabled: false,
  createdAt: new Date("2026-06-01T00:00:00Z"),
  updatedAt: new Date("2026-06-01T00:00:00Z"),
  lastDelivery: null,
};

function render(canWrite: boolean): string {
  return renderToStaticMarkup(
    createElement(SubscriptionsTable, {
      subscriptions: [platformSub, projectSub],
      canWrite,
      onEdit() {},
      onPing() {},
      onShowDeliveries() {},
      onToggleEnabled() {},
    }),
  );
}

describe("SubscriptionsTable", () => {
  it("renders the column set and a sample row", () => {
    const markup = render(true);

    // Column headers.
    expect(markup).toContain("colName");
    expect(markup).toContain("colHost");
    expect(markup).toContain("colScope");
    expect(markup).toContain("colEvents");
    expect(markup).toContain("colEnabled");
    expect(markup).toContain("colLastDelivery");
    expect(markup).toContain("colActions");

    // Sample row: name + parsed URL host (not the full URL path).
    expect(markup).toContain("Ops notifier");
    expect(markup).toContain("hooks.example.com");
    expect(markup).not.toContain("https://hooks.example.com/ops");

    // Scope badges for both platform and project rows.
    expect(markup).toContain("scopePlatform");
    expect(markup).toContain("scopeProject");

    // Event-type chips, with "*" rendered as the all-events label.
    expect(markup).toContain("run.done");
    expect(markup).toContain("allEvents");

    // Last-delivery status (delivered) and the none case for the second row.
    expect(markup).toContain("deliveryStatus.delivered");
    expect(markup).toContain("deliveryStatus.none");

    // Write + read actions all present when canWrite is true.
    expect(markup).toContain("editAction");
    expect(markup).toContain("pingAction");
    expect(markup).toContain("deliveriesAction");
  });

  it("hides write actions when canWrite is false", () => {
    const markup = render(false);

    // Edit + the enabled toggle button are write actions → hidden.
    expect(markup).not.toContain("editAction");
    expect(markup).not.toContain("aria-pressed");

    // Read actions remain available.
    expect(markup).toContain("pingAction");
    expect(markup).toContain("deliveriesAction");

    // Enabled state is still displayed (read-only).
    expect(markup).toContain("enabledOn");
    expect(markup).toContain("enabledOff");
  });

  it("renders the empty state with no subscriptions", () => {
    const markup = renderToStaticMarkup(
      createElement(SubscriptionsTable, {
        subscriptions: [],
        canWrite: true,
        onEdit() {},
        onPing() {},
        onShowDeliveries() {},
        onToggleEnabled() {},
      }),
    );

    expect(markup).toContain("empty");
  });
});
