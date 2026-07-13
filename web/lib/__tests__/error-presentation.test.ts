import { describe, expect, it } from "vitest";

import { errorCodeFromUnknown } from "@/lib/error-presentation";

describe("error boundary presentation", () => {
  it("extracts only a recognized structural MaisterError code", () => {
    expect(errorCodeFromUnknown({ code: "CONFLICT" })).toBe("CONFLICT");
    expect(errorCodeFromUnknown({ code: "ACCOUNT_INACTIVE" })).toBe(
      "ACCOUNT_INACTIVE",
    );
  });

  it.each([
    new Error("server secret"),
    { code: "UNKNOWN", message: "server secret" },
    { code: 503 },
    null,
    "CRASH",
  ])("does not expose malformed boundary input %#", (error) => {
    expect(errorCodeFromUnknown(error)).toBeNull();
  });
});
