import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { describe, expect, it } from "vitest";

import { scaffoldArtifact } from "@/lib/local-packages/scaffold";

const manifest: AuthoredFlowPackageFile = {
  kind: "manifest",
  path: "maister-package.yaml",
  content: ["schemaVersion: 1", "name: pkg", "flows: []", ""].join("\n"),
};

function find(
  files: AuthoredFlowPackageFile[],
  path: string,
): string | undefined {
  return files.find((f) => f.path === path)?.content;
}

describe("scaffoldArtifact (ADR-116 P5)", () => {
  it("flow → flows/<name>/flow.yaml + appends manifest flows[] + canvas nav", () => {
    const res = scaffoldArtifact({
      kind: "flow",
      name: "build",
      packageId: "pkg1",
      draftFiles: [manifest],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(find(res.files, "flows/build/flow.yaml")).toContain("name: build");
    // Manifest gained the flow entry (id + path).
    const manifestOut = find(res.files, "maister-package.yaml") ?? "";

    expect(manifestOut).toContain("id: build");
    expect(manifestOut).toContain("path: flows/build");
    expect(res.navigate).toBe("/studio/edit/pkg1/flows/build/flow.yaml");
  });

  it("skill → skills/<name>/SKILL.md + skill-screen nav", () => {
    const res = scaffoldArtifact({
      kind: "skill",
      name: "arch",
      packageId: "pkg1",
      draftFiles: [manifest],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(find(res.files, "skills/arch/SKILL.md")).toContain("name: arch");
    expect(res.navigate).toBe("/studio/edit/pkg1/skills/arch");
  });

  it("subagent → capability/<cap>/agents/<name>.md (requires a capability)", () => {
    const ok = scaffoldArtifact({
      kind: "subagent",
      name: "helper",
      capability: "core",
      packageId: "pkg1",
      draftFiles: [manifest],
    });

    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(find(ok.files, "capability/core/agents/helper.md")).toContain(
      "name: helper",
    );
    expect(ok.navigate).toBe("/studio/edit/pkg1?tab=subagents&sel=helper");

    const missingCap = scaffoldArtifact({
      kind: "subagent",
      name: "helper",
      packageId: "pkg1",
      draftFiles: [manifest],
    });

    expect(missingCap).toEqual({
      ok: false,
      code: "PRECONDITION",
      message: "invalid capability: undefined",
    });
  });

  it("agent / mcp / rule → their exact paths + inline nav", () => {
    const agent = scaffoldArtifact({
      kind: "agent",
      name: "triager",
      packageId: "pkg1",
      draftFiles: [manifest],
    });
    const mcp = scaffoldArtifact({
      kind: "mcp",
      name: "github",
      packageId: "pkg1",
      draftFiles: [manifest],
    });
    const rule = scaffoldArtifact({
      kind: "rule",
      name: "style",
      packageId: "pkg1",
      draftFiles: [manifest],
    });

    expect(
      agent.ok && find(agent.files, "maister-agents/triager.md"),
    ).toContain("name: triager");
    expect(agent.ok && agent.navigate).toBe(
      "/studio/edit/pkg1?tab=agents&sel=triager",
    );
    expect(mcp.ok && find(mcp.files, "mcps/github.yaml")).toContain(
      "id: github",
    );
    expect(rule.ok && find(rule.files, "rules/style.md")).toContain(
      "name: style",
    );
  });

  it("rejects a colliding path with CONFLICT", () => {
    const res = scaffoldArtifact({
      kind: "rule",
      name: "style",
      packageId: "pkg1",
      draftFiles: [
        manifest,
        { kind: "rule", path: "rules/style.md", content: "x" },
      ],
    });

    expect(res).toEqual({
      ok: false,
      code: "CONFLICT",
      message: "rules/style.md",
    });
  });

  it("rejects an invalid name with PRECONDITION", () => {
    const res = scaffoldArtifact({
      kind: "rule",
      name: "../escape",
      packageId: "pkg1",
      draftFiles: [manifest],
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("PRECONDITION");
  });

  it("flow on an unparseable manifest fails with CONFIG (nothing half-written)", () => {
    const res = scaffoldArtifact({
      kind: "flow",
      name: "build",
      packageId: "pkg1",
      draftFiles: [
        {
          kind: "manifest",
          path: "maister-package.yaml",
          content: "name: [bad",
        },
      ],
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("CONFIG");
  });
});
