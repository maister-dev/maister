import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RuntimeEventEnvelopeSchema } from "../runtime-events";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../../contracts/fixtures/runtime-events/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
}

describe("execution-host runtime event wire boundary", () => {
  it("accepts the shared open-payload positive fixture", () => {
    expect(
      RuntimeEventEnvelopeSchema.safeParse(fixture("envelope.valid.json"))
        .success,
    ).toBe(true);
  });

  it("rejects unsafe or precision-losing shared fixtures", () => {
    expect(
      RuntimeEventEnvelopeSchema.safeParse(
        fixture("envelope.invalid-number-sequence.json"),
      ).success,
    ).toBe(false);
    expect(
      RuntimeEventEnvelopeSchema.safeParse(
        fixture("envelope.invalid-unsafe-payload.json"),
      ).success,
    ).toBe(false);
  });
});
