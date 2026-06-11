// M30 (ADR-078): rework session_policy — 3-level highest-wins resolution
// with the deliberate `resume` engine default:
//   rework-transition (`rework.session_policy`) > node (`session_policy`)
//   > flow (`defaults.session_policy`) > engine default `resume`.

import { describe, expect, it } from "vitest";

import { resolveSessionPolicy } from "@/lib/flows/graph/session-policy";

describe("resolveSessionPolicy (ADR-078, DD8)", () => {
  it("defaults to resume when nothing is declared (the deliberate flip)", () => {
    const r = resolveSessionPolicy({});

    expect(r.policy).toBe("resume");
    expect(r.source).toBe("engine-default");
  });

  it("flow defaults override the engine default", () => {
    const r = resolveSessionPolicy({ flowDefault: "new_session" });

    expect(r.policy).toBe("new_session");
    expect(r.source).toBe("flow-defaults");
  });

  it("node session_policy overrides flow defaults", () => {
    const r = resolveSessionPolicy({
      flowDefault: "new_session",
      nodePolicy: "resume",
    });

    expect(r.policy).toBe("resume");
    expect(r.source).toBe("node");
  });

  it("rework-transition session_policy wins over everything", () => {
    const r = resolveSessionPolicy({
      flowDefault: "resume",
      nodePolicy: "new_session",
      reworkPolicy: "resume",
    });

    expect(r.policy).toBe("resume");
    expect(r.source).toBe("rework-transition");

    const r2 = resolveSessionPolicy({
      flowDefault: "resume",
      nodePolicy: "resume",
      reworkPolicy: "new_session",
    });

    expect(r2.policy).toBe("new_session");
    expect(r2.source).toBe("rework-transition");
  });
});
