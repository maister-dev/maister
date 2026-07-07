import { describe, expect, it } from "vitest";

import { getAdapterSupportById } from "@/lib/acp-runners/adapter-support";

describe("adapter support descriptors", () => {
  it("declares read-only-session smoke requirements explicitly", () => {
    expect(getAdapterSupportById("claude")?.readOnlySessionSmoke).toBe(
      "not_required",
    );
    expect(getAdapterSupportById("codex")?.readOnlySessionSmoke).toBe(
      "not_required",
    );
    expect(getAdapterSupportById("gemini")?.readOnlySessionSmoke).toBe(
      "required",
    );
    expect(getAdapterSupportById("opencode")?.readOnlySessionSmoke).toBe(
      "required",
    );
    expect(getAdapterSupportById("mimo")?.readOnlySessionSmoke).toBe(
      "required",
    );
  });
});
