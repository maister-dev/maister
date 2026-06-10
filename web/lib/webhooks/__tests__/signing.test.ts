import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  buildDeliveryHeaders,
  buildSignatureHeader,
  hmacHex,
  idempotencyKey,
  isEnvRef,
  resolveEnvRef,
  resolveMaybeEnvRef,
  signatureBaseString,
} from "@/lib/webhooks/signing";

// =============================================================================
// T4 — outbound-webhooks signing (TDD red).
//
// Pins the signing/rotation/header contract from
// docs/system-analytics/outbound-webhooks.md ("Signing and rotation",
// "Identifier discipline") and the asyncapi DeliveryHeaders schema.
//
// The HMAC and sha256 assertions use independent `node:crypto` references so a
// passing test proves a CONSUMER (who only has node:crypto + the documented
// recipe) can verify the signature. Module `@/lib/webhooks/signing` does not
// exist yet — these MUST fail with module-not-found until landed verbatim.
// =============================================================================

// Reference implementations a third-party consumer would write from the docs.
const refSha256Hex = (s: string) =>
  createHash("sha256").update(s).digest("hex");
const refHmacHex = (secret: string, base: string) =>
  createHmac("sha256", secret).update(base).digest("hex");

describe("isEnvRef", () => {
  it("matches ^env:[A-Za-z_][A-Za-z0-9_]*$", () => {
    expect(isEnvRef("env:FOO")).toBe(true);
    expect(isEnvRef("env:_underscore")).toBe(true);
    expect(isEnvRef("env:WH_SECRET_1")).toBe(true);
    expect(isEnvRef("env:a")).toBe(true);
  });

  it("rejects names starting with a digit", () => {
    expect(isEnvRef("env:1bad")).toBe(false);
  });

  it("rejects plain literals and malformed refs", () => {
    expect(isEnvRef("literal")).toBe(false);
    expect(isEnvRef("notenv")).toBe(false);
    expect(isEnvRef("env:")).toBe(false);
    expect(isEnvRef("env:bad-dash")).toBe(false);
    expect(isEnvRef("env:has space")).toBe(false);
    expect(isEnvRef("ENV:FOO")).toBe(false);
    expect(isEnvRef("")).toBe(false);
    expect(isEnvRef("env:FOO:BAR")).toBe(false);
  });
});

describe("resolveEnvRef", () => {
  it("resolves env:NAME to the env value", () => {
    expect(resolveEnvRef("env:WH_X", { WH_X: "s3cr3t" })).toBe("s3cr3t");
  });

  it("throws MaisterError CONFIG when the var is unset", () => {
    let thrown: unknown;

    try {
      resolveEnvRef("env:MISSING", {});
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MaisterError);
    expect((thrown as MaisterError).code).toBe("CONFIG");
    // the var NAME is actionable and must appear; no secret value exists here.
    expect((thrown as Error).message).toContain("MISSING");
  });

  it("throws MaisterError CONFIG when the var is blank", () => {
    let thrown: unknown;

    try {
      resolveEnvRef("env:WH_BLANK", { WH_BLANK: "" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MaisterError);
    expect((thrown as MaisterError).code).toBe("CONFIG");
    expect((thrown as Error).message).toContain("WH_BLANK");
  });

  it("CONFIG message names the var but NEVER leaks any secret value", () => {
    // A sibling var holds a secret; the thrown message about the MISSING ref
    // must not accidentally echo any value from the env map.
    const env = { OTHER_SECRET: "ghp_TOPSECRETvalue9999" };
    let thrown: unknown;

    try {
      resolveEnvRef("env:MISSING", env);
    } catch (err) {
      thrown = err;
    }

    expect((thrown as MaisterError).code).toBe("CONFIG");
    expect((thrown as Error).message).toContain("MISSING");
    expect((thrown as Error).message).not.toContain("ghp_TOPSECRETvalue9999");
  });

  it("throws MaisterError CONFIG for a malformed (non-env) ref", () => {
    let thrown: unknown;

    try {
      resolveEnvRef("notenv", {});
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MaisterError);
    expect((thrown as MaisterError).code).toBe("CONFIG");
  });

  it("throws MaisterError CONFIG for a raw value (not an env: ref)", () => {
    let thrown: unknown;

    try {
      resolveEnvRef("s3cr3t-raw-value", { "s3cr3t-raw-value": "x" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MaisterError);
    expect((thrown as MaisterError).code).toBe("CONFIG");
  });
});

describe("resolveMaybeEnvRef", () => {
  it("returns a plain literal verbatim", () => {
    expect(resolveMaybeEnvRef("plain")).toBe("plain");
    expect(resolveMaybeEnvRef("https://hooks.example.com")).toBe(
      "https://hooks.example.com",
    );
  });

  it("resolves an env: ref through resolveEnvRef", () => {
    expect(resolveMaybeEnvRef("env:WH_X", { WH_X: "v" })).toBe("v");
  });

  it("throws CONFIG when an env: ref is unset", () => {
    let thrown: unknown;

    try {
      resolveMaybeEnvRef("env:MISSING", {});
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MaisterError);
    expect((thrown as MaisterError).code).toBe("CONFIG");
  });
});

describe("idempotencyKey", () => {
  it("is 64-char lowercase hex", () => {
    const key = idempotencyKey("sub_1", "evt_1");

    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across repeated calls", () => {
    expect(idempotencyKey("sub_1", "evt_1")).toBe(
      idempotencyKey("sub_1", "evt_1"),
    );
  });

  it("equals the independent sha256(`${subId}:${eventId}`) reference", () => {
    const subId = "11111111-1111-4111-8111-111111111111";
    const eventId = "22222222-2222-4222-8222-222222222222";

    expect(idempotencyKey(subId, eventId)).toBe(
      refSha256Hex(`${subId}:${eventId}`),
    );
  });

  it("differs when subscription or event differs (no collision on join boundary)", () => {
    // `a:bc` vs `ab:c` must NOT collide — the literal colon is part of the input.
    expect(idempotencyKey("a", "bc")).not.toBe(idempotencyKey("ab", "c"));
    expect(idempotencyKey("sub_1", "evt_1")).not.toBe(
      idempotencyKey("sub_2", "evt_1"),
    );
    expect(idempotencyKey("sub_1", "evt_1")).not.toBe(
      idempotencyKey("sub_1", "evt_2"),
    );
  });
});

describe("signatureBaseString", () => {
  it("is `${t}.${deliveryId}.${rawBody}` with literal dots", () => {
    expect(signatureBaseString(1700000000, "del_1", '{"a":1}')).toBe(
      '1700000000.del_1.{"a":1}',
    );
  });

  it("keeps the rawBody bytes intact even when they contain dots", () => {
    expect(signatureBaseString(1749556205, "del_x", '{"k":"a.b.c"}')).toBe(
      '1749556205.del_x.{"k":"a.b.c"}',
    );
  });
});

describe("hmacHex", () => {
  it("equals the independent HMAC-SHA256 hex reference (consumer can verify)", () => {
    const secret = "whsec_test_key";
    const base = '1700000000.del_1.{"a":1}';

    expect(hmacHex(secret, base)).toBe(refHmacHex(secret, base));
  });

  it("is lowercase hex", () => {
    expect(hmacHex("k", "msg")).toMatch(/^[0-9a-f]+$/);
  });

  it("changes when the secret changes (rotation produces a distinct digest)", () => {
    const base = "1700000000.del_1.body";

    expect(hmacHex("secretA", base)).not.toBe(hmacHex("secretB", base));
  });
});

describe("buildSignatureHeader", () => {
  const t = 1749556205;
  const deliveryId = "del_9a4a7b9d0d6b4b27";
  const rawBody = '{"apiVersion":1,"type":"run.review"}';
  const secret = "whsec_primary";
  const secondarySecret = "whsec_secondary";

  it("single-secret → t=<t>,v1=<hex> with hex matching the reference", () => {
    const header = buildSignatureHeader({ t, deliveryId, rawBody, secret });
    const base = `${t}.${deliveryId}.${rawBody}`;
    const expected = refHmacHex(secret, base);

    expect(header).toBe(`t=${t},v1=${expected}`);
  });

  it("matches the documented header grammar (single v1)", () => {
    const header = buildSignatureHeader({ t, deliveryId, rawBody, secret });

    expect(header).toMatch(/^t=[0-9]+,v1=[0-9a-f]+$/);
  });

  it("ignores a null secondarySecret (single v1 entry)", () => {
    const header = buildSignatureHeader({
      t,
      deliveryId,
      rawBody,
      secret,
      secondarySecret: null,
    });

    expect(header).toMatch(/^t=[0-9]+,v1=[0-9a-f]+$/);
    expect(header.match(/v1=/g)).toHaveLength(1);
  });

  it("with secondarySecret → two v1= entries, second matches the secondary HMAC", () => {
    const header = buildSignatureHeader({
      t,
      deliveryId,
      rawBody,
      secret,
      secondarySecret,
    });
    const base = `${t}.${deliveryId}.${rawBody}`;
    const primaryHex = refHmacHex(secret, base);
    const secondaryHex = refHmacHex(secondarySecret, base);

    // Stripe-scheme: primary first, secondary appended.
    expect(header).toBe(`t=${t},v1=${primaryHex},v1=${secondaryHex}`);
    expect(header).toMatch(/^t=[0-9]+,v1=[0-9a-f]+,v1=[0-9a-f]+$/);
    expect(header.match(/v1=/g)).toHaveLength(2);
  });
});

describe("buildDeliveryHeaders", () => {
  const input = {
    type: "run.review" as const,
    eventId: "evt_8a4a7b9d0d6b4b27",
    deliveryId: "del_9a4a7b9d0d6b4b27",
    subscriptionId: "sub_42",
    t: 1749556205,
    rawBody: '{"apiVersion":1,"type":"run.review"}',
    secret: "whsec_primary",
  };

  it("contains the exact fixed headers", () => {
    const headers = buildDeliveryHeaders(input);

    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("MAIster-Webhooks/1");
    expect(headers["X-Maister-Event"]).toBe("run.review");
    expect(headers["X-Maister-Event-Id"]).toBe("evt_8a4a7b9d0d6b4b27");
    expect(headers["X-Maister-Delivery-Id"]).toBe("del_9a4a7b9d0d6b4b27");
  });

  it("sets X-Maister-Idempotency-Key == idempotencyKey(subId,eventId)", () => {
    const headers = buildDeliveryHeaders(input);

    expect(headers["X-Maister-Idempotency-Key"]).toBe(
      idempotencyKey(input.subscriptionId, input.eventId),
    );
    expect(headers["X-Maister-Idempotency-Key"]).toBe(
      refSha256Hex(`${input.subscriptionId}:${input.eventId}`),
    );
  });

  it("sets X-Maister-Signature == buildSignatureHeader output", () => {
    const headers = buildDeliveryHeaders(input);

    expect(headers["X-Maister-Signature"]).toBe(
      buildSignatureHeader({
        t: input.t,
        deliveryId: input.deliveryId,
        rawBody: input.rawBody,
        secret: input.secret,
      }),
    );
  });

  it("appends a second v1= when a secondarySecret is supplied", () => {
    const headers = buildDeliveryHeaders({
      ...input,
      secondarySecret: "whsec_secondary",
    });

    expect(headers["X-Maister-Signature"]).toMatch(
      /^t=[0-9]+,v1=[0-9a-f]+,v1=[0-9a-f]+$/,
    );
  });

  it("merges extraHeaders (custom static header passes through)", () => {
    const headers = buildDeliveryHeaders({
      ...input,
      extraHeaders: { "X-Custom": "abc", Authorization: "Bearer resolved" },
    });

    expect(headers["X-Custom"]).toBe("abc");
    expect(headers["Authorization"]).toBe("Bearer resolved");
  });

  it("reserved signature/idempotency/event headers WIN over caller-supplied extraHeaders", () => {
    const reservedSig = buildSignatureHeader({
      t: input.t,
      deliveryId: input.deliveryId,
      rawBody: input.rawBody,
      secret: input.secret,
    });
    const reservedKey = idempotencyKey(input.subscriptionId, input.eventId);

    const headers = buildDeliveryHeaders({
      ...input,
      extraHeaders: {
        "X-Maister-Signature": "t=0,v1=deadbeef",
        "X-Maister-Idempotency-Key":
          "0000000000000000000000000000000000000000000000000000000000000000",
        "X-Maister-Event": "ping",
        "X-Maister-Event-Id": "evt_spoofed",
        "X-Maister-Delivery-Id": "del_spoofed",
        "Content-Type": "text/plain",
        "User-Agent": "Evil/9",
      },
    });

    expect(headers["X-Maister-Signature"]).toBe(reservedSig);
    expect(headers["X-Maister-Idempotency-Key"]).toBe(reservedKey);
    expect(headers["X-Maister-Event"]).toBe("run.review");
    expect(headers["X-Maister-Event-Id"]).toBe("evt_8a4a7b9d0d6b4b27");
    expect(headers["X-Maister-Delivery-Id"]).toBe("del_9a4a7b9d0d6b4b27");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("MAIster-Webhooks/1");
  });
});
