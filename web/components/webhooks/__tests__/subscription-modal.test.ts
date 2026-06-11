import type { SubscriptionModalValue } from "@/components/webhooks/subscription-modal";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { SubscriptionModal } from "@/components/webhooks/subscription-modal";

const initial: SubscriptionModalValue = {
  name: "Ops notifier",
  url: "https://hooks.example.com/ops",
  method: "POST",
  headers: { "X-Team": "core" },
  event_types: ["run.done"],
  signing_secret_ref: "env:WEBHOOK_SIGNING_SECRET",
  secondary_signing_secret_ref: null,
  enabled: true,
};

function renderCreate(): string {
  return renderToStaticMarkup(
    createElement(SubscriptionModal, {
      open: true,
      mode: "create",
      onSubmit() {},
      onClose() {},
    }),
  );
}

describe("SubscriptionModal", () => {
  it("renders all field labels in create mode", () => {
    const markup = renderCreate();

    expect(markup).toContain("createTitle");
    expect(markup).toContain("fieldName");
    expect(markup).toContain("fieldUrl");
    expect(markup).toContain("fieldMethod");
    expect(markup).toContain("fieldEventTypes");
    expect(markup).toContain("fieldHeaders");
    expect(markup).toContain("fieldSigningSecretRef");
    expect(markup).toContain("fieldSecondarySigningSecretRef");
    expect(markup).toContain("fieldEnabled");
  });

  it("offers the event-type options including the all-events wildcard", () => {
    const markup = renderCreate();

    // A representative subset of the taxonomy plus the "*"/all option.
    expect(markup).toContain("run.started");
    expect(markup).toContain("hitl.requested");
    expect(markup).toContain("gate.decided");
    expect(markup).toContain("allEvents");
  });

  it("exposes an env: secret-ref input and NO raw secret-value field", () => {
    const markup = renderCreate();

    // Security-critical: the signing-secret field is an env:NAME REFERENCE
    // input (placeholder advertises env:NAME), never a raw value box.
    expect(markup).toContain("env:WEBHOOK_SIGNING_SECRET");
    expect(markup).toContain("secretRefHint");

    // No field is bound to a raw secret value: no password input, and no
    // label/field keyed to a literal "secret value" / "signing_secret".
    expect(markup).not.toContain('type="password"');
    expect(markup.toLowerCase()).not.toContain("secret value");
    expect(markup).not.toContain("signingSecretValue");
    expect(markup).not.toContain("signing_secret_value");
  });

  it("seeds the edit form from the initial value (refs, not values)", () => {
    const markup = renderToStaticMarkup(
      createElement(SubscriptionModal, {
        open: true,
        mode: "edit",
        initial,
        onSubmit() {},
        onClose() {},
      }),
    );

    expect(markup).toContain("editTitle");
    expect(markup).toContain("Ops notifier");
    expect(markup).toContain("https://hooks.example.com/ops");
    // The stored signing-secret REF is echoed back; it is an env:NAME string.
    expect(markup).toContain("env:WEBHOOK_SIGNING_SECRET");
  });

  it("renders nothing when closed", () => {
    const markup = renderToStaticMarkup(
      createElement(SubscriptionModal, {
        open: false,
        mode: "create",
        onSubmit() {},
        onClose() {},
      }),
    );

    expect(markup).toBe("");
  });
});
