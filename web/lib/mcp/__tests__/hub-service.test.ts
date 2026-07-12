import { describe, expect, it } from "vitest";

import { composeProjectMcpHub } from "@/lib/mcp/hub-service";

// ADR-129 (W-D): the hub read model merges 3 sources + derives the requirements
// ledger + the project-effective count. Pure over already-loaded rows. The
// declared refs (package + flow + agent) are aggregated upstream by
// `deriveDeclaredRefs` (tested in requirements-ledger.test.ts) and passed in.

const cap = (
  refId: string,
  source: string,
  extra: Partial<{
    transport: string;
    requirement: boolean;
    disabled: boolean;
  }> = {},
) => ({
  capability_ref_id: refId,
  source,
  material: {
    transport: extra.transport ?? "stdio",
    ...(extra.requirement ? { requirement: true } : {}),
  },
  disabled_at: extra.disabled ? new Date() : null,
});

const declared = (
  refId: string,
  required = true,
  declaredBy: string[] = ["package:p"],
) => ({ refId, required, declaredBy });

describe("composeProjectMcpHub (W-D)", () => {
  it("merges platform, project, and package servers, excluding requirement markers", () => {
    const hub = composeProjectMcpHub({
      capabilityRows: [
        cap("github", "platform"),
        cap("local-fs", "project"),
        cap("pkg-tool", "flow-package"),
        cap("needs-db", "flow-package", { requirement: true }),
      ],
      platformRows: [
        {
          id: "github",
          transport: "stdio",
          trust_status: "trusted",
          readiness_status: "Ready",
          last_probe_status: "Ok",
          enabled: true,
        },
      ],
      bindings: [],
      usedByByServerId: new Map([["github", 3]]),
      declaredRefs: [declared("needs-db")],
    });

    const bySource = new Map(hub.servers.map((s) => [s.refId, s]));

    expect(hub.servers).toHaveLength(3); // requirement marker excluded
    expect(bySource.get("github")?.source).toBe("platform");
    expect(bySource.get("github")?.trust).toBe("trusted");
    expect(bySource.get("github")?.usedByCount).toBe(3);
    expect(bySource.get("local-fs")?.source).toBe("project");
    expect(bySource.get("pkg-tool")?.source).toBe("package");
  });

  it("classifies a package requirement: auto when a candidate matches, unbound when none", () => {
    const hub = composeProjectMcpHub({
      capabilityRows: [
        cap("github", "flow-package", { requirement: true }),
        cap("github", "platform"), // grandfather candidate for the same ref
        cap("ghost", "flow-package", { requirement: true }), // no candidate
      ],
      platformRows: [
        {
          id: "github",
          transport: "stdio",
          trust_status: "trusted",
          readiness_status: "Ready",
          last_probe_status: null,
          enabled: true,
        },
      ],
      bindings: [],
      usedByByServerId: new Map(),
      declaredRefs: [declared("github"), declared("ghost")],
    });

    const byRef = new Map(hub.requirements.map((r) => [r.refId, r]));

    expect(byRef.get("github")?.classification).toBe("auto");
    expect(byRef.get("ghost")?.classification).toBe("unbound");
    // effective count = the auto-satisfied ref only.
    expect(hub.effectiveCount).toBe(1);
  });

  it("surfaces flow- and agent-declared requirements (not only package/binding)", () => {
    // A ref required by an enabled flow, satisfied by a platform candidate ⇒
    // auto; a ref required by an attached agent with no candidate ⇒ unbound.
    const hub = composeProjectMcpHub({
      capabilityRows: [cap("filesystem", "platform")],
      platformRows: [
        {
          id: "filesystem",
          transport: "stdio",
          trust_status: "trusted",
          readiness_status: "Ready",
          last_probe_status: null,
          enabled: true,
        },
      ],
      bindings: [],
      usedByByServerId: new Map(),
      declaredRefs: [
        declared("filesystem", true, ["flow:bugfix"]),
        declared("search", true, ["agent:core:triager"]),
      ],
    });

    const byRef = new Map(hub.requirements.map((r) => [r.refId, r]));

    expect(byRef.get("filesystem")?.classification).toBe("auto");
    expect(byRef.get("filesystem")?.declaredBy).toEqual(["flow:bugfix"]);
    expect(byRef.get("search")?.classification).toBe("unbound");
    expect(hub.effectiveCount).toBe(1);
  });

  it("classifies a bound requirement as bound, and a disabled binding as unbound", () => {
    const hub = composeProjectMcpHub({
      capabilityRows: [cap("github", "flow-package", { requirement: true })],
      platformRows: [
        {
          id: "github",
          transport: "stdio",
          trust_status: "trusted",
          readiness_status: "Ready",
          last_probe_status: null,
          enabled: true,
        },
      ],
      bindings: [
        {
          ref_id: "github",
          target_kind: "platform",
          enabled: true,
          config_overlay: null,
        },
      ],
      usedByByServerId: new Map(),
      declaredRefs: [declared("github")],
    });

    expect(hub.requirements[0].classification).toBe("bound");

    const disconnected = composeProjectMcpHub({
      capabilityRows: [cap("github", "flow-package", { requirement: true })],
      platformRows: [],
      bindings: [
        {
          ref_id: "github",
          target_kind: "platform",
          enabled: false,
          config_overlay: null,
        },
      ],
      usedByByServerId: new Map(),
      declaredRefs: [declared("github")],
    });

    expect(disconnected.requirements[0].classification).toBe("unbound");
    expect(disconnected.effectiveCount).toBe(0);
  });

  it("classifies a bound-but-untrusted platform target as not_ready", () => {
    const hub = composeProjectMcpHub({
      capabilityRows: [cap("github", "flow-package", { requirement: true })],
      platformRows: [
        {
          id: "github",
          transport: "stdio",
          trust_status: "untrusted",
          readiness_status: "Ready",
          last_probe_status: null,
          enabled: true,
        },
      ],
      bindings: [
        {
          ref_id: "github",
          target_kind: "platform",
          enabled: true,
          config_overlay: null,
        },
      ],
      usedByByServerId: new Map(),
      declaredRefs: [declared("github")],
    });

    expect(hub.requirements[0].classification).toBe("not_ready");
  });
});
