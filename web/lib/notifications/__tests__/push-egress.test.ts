// ---------------------------------------------------------------------------
// UT-NTF-11 — a push endpoint is an outbound destination, and gets the ADR-077
// egress policy rather than a second, weaker one.
//
// A push endpoint is a browser-supplied absolute URL that the manager then
// fetches. Without this guard any authenticated reader could register
// `https://127.0.0.1:<port>/…`, enable web_push, and turn the delivery job into
// an SSRF primitive against private services — `web-push` calls
// `https.request` with no destination policy of its own, and unlike the webhook
// transport nothing here validated or pinned.
//
// The registration half is asserted on the shared policy function the route
// calls; the send half is asserted through `sendPush` with the transport mocked,
// so a regression shows up as "the wire was reached" rather than as a timeout.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendNotification = vi.fn();

vi.mock("web-push", () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

import { assertAllowedDestinationUrl } from "@/lib/webhooks/destination";
import { sendPush } from "@/lib/notifications/push-sender";

const TARGET = { id: "p1", p256dh: "k", auth: "a" };
const PAYLOAD = { title: "t", body: "b", url: "/", tag: "maister" };

beforeEach(() => {
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  process.env.MAISTER_VAPID_PUBLIC_KEY = "pub";
  process.env.MAISTER_VAPID_PRIVATE_KEY = "priv";
  process.env.MAISTER_VAPID_SUBJECT = "mailto:e2e@maister.local";
  delete process.env.MAISTER_WEBHOOK_ALLOW_HOSTS;
});

describe("UT-NTF-11 registration refuses a private destination", () => {
  for (const blocked of [
    "https://127.0.0.1/push",
    "https://10.1.2.3/push",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/push",
  ]) {
    it(`refuses ${blocked}`, () => {
      expect(() => assertAllowedDestinationUrl(new URL(blocked))).toThrow();
    });
  }

  it("admits an ordinary public push service", () => {
    expect(() =>
      assertAllowedDestinationUrl(
        new URL("https://fcm.googleapis.com/fcm/send/x"),
      ),
    ).not.toThrow();
  });
});

describe("UT-NTF-11 the sender never reaches the wire for a blocked endpoint", () => {
  it("settles terminal on a loopback endpoint instead of sending", async () => {
    const result = await sendPush(
      { ...TARGET, endpoint: "https://127.0.0.1:9999/push" },
      PAYLOAD,
    );

    // Terminal, not retryable: a private address does not become public by
    // waiting, and retrying would keep probing it on the whole curve.
    expect(result.outcome).toBe("terminal");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("refuses a non-https endpoint", async () => {
    const result = await sendPush(
      { ...TARGET, endpoint: "http://push.example.com/x" },
      PAYLOAD,
    );

    expect(result.outcome).toBe("terminal");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("refuses a malformed endpoint rather than throwing at the caller", async () => {
    const result = await sendPush(
      { ...TARGET, endpoint: "not-a-url" },
      PAYLOAD,
    );

    expect(result.outcome).toBe("terminal");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("pins the connection for an endpoint it does allow", async () => {
    const result = await sendPush(
      { ...TARGET, endpoint: "https://example.com/push/abc" },
      PAYLOAD,
    );

    expect(result.outcome).toBe("delivered");
    expect(sendNotification).toHaveBeenCalledTimes(1);

    // The pinned agent is what closes DNS rebinding: registration vetted a
    // name, and by send time that name can resolve elsewhere. Asserting the
    // agent reached the transport is the difference between "we resolved" and
    // "we connected to what we resolved".
    const options = sendNotification.mock.calls[0][2] as { agent?: unknown };

    expect(options.agent).toBeDefined();
  });
});
