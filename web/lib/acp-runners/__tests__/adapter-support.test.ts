import { describe, expect, it } from "vitest";

import {
  getAdapterSupportById,
  mcpTransportsForAdapter,
} from "@/lib/acp-runners/adapter-support";

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

  it("requires capability-enforcement smoke for every adapter (ADR-130)", () => {
    for (const id of ["claude", "codex", "gemini", "opencode", "mimo"]) {
      expect(getAdapterSupportById(id)?.capabilityEnforcementSmoke).toBe(
        "required",
      );
    }
  });

  // ADR-177: the two VERIFIED adapter facts, read through the accessor that
  // makes `mcpTransports` load-bearing. Not a per-adapter enumeration — the
  // other three carry an explicit unverified marker and pinning them here would
  // assert a guess.
  it("codex cannot use sse — codex-acp throws invalidRequest building the config", () => {
    expect(mcpTransportsForAdapter("codex")).toEqual(["stdio", "http"]);
  });

  it("claude accepts sse", () => {
    expect(mcpTransportsForAdapter("claude")).toContain("sse");
  });
});
