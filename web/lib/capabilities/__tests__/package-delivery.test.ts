import type { CapabilityCatalogRecord } from "../types";

import { describe, expect, it } from "vitest";

import { agentMcpTargets } from "../mcp-targets";
import {
  resolvePackageSession,
  sessionNameForPackageNode,
  type FlowDeliverySnapshot,
} from "../package-delivery";

import { packageMcpMaterial } from "@/lib/packages/mcp-material";

const core = {
  name: "core",
  installId: "core1",
  revision: "c",
  shareSkills: true,
  skills: ["code", "common"],
  mcps: [{ refId: "issues", effective: "project" as const }],
  bundleIds: ["core-b"],
};
const design = {
  name: "design",
  installId: "design1",
  revision: "d",
  shareSkills: false,
  skills: ["common", "design"],
  mcps: [{ refId: "figma", effective: "package" as const }],
  bundleIds: ["design-b"],
};
const dev = {
  name: "dev",
  installId: "dev1",
  revision: "v",
  shareSkills: false,
  skills: ["implement"],
  mcps: [{ refId: "git", effective: "package" as const }],
  bundleIds: ["dev-b"],
};
const persona = {
  agentId: "design:artist",
  installId: "design1",
  definitionDigest: "abc",
  mode: "session" as const,
  skills: ["common"],
  mcpRefs: ["figma"],
  promptOverride: null,
  linkRevision: null,
};
const run: FlowDeliverySnapshot = {
  version: 1,
  flowPackageName: "dev",
  packages: [core, design, dev],
  bindings: { sketch: persona },
  nonPackageMcpRefs: ["repo"],
};

describe("IT-CAP-03/04 package delivery", () => {
  it("resolves Flow, agent and explicit empty contributions independently", () => {
    expect(
      resolvePackageSession(run, "build").skills.map((s) => s.slug),
    ).toEqual(["code", "common", "implement"]);
    expect(resolvePackageSession(run, "build").mcps).toEqual([
      "git",
      "issues",
      "repo",
    ]);
    const scoped = resolvePackageSession(run, "sketch");

    expect(scoped.skills.find((s) => s.slug === "common")?.installId).toBe(
      "design1",
    );
    expect(scoped.skills.map((s) => s.slug)).not.toContain("design");
    expect(scoped.mcps).toEqual(["figma", "issues", "repo"]);
    expect(resolvePackageSession(run, "sketch", []).mcps).toEqual(["issues"]);
    expect(
      resolvePackageSession(
        {
          ...run,
          flowPackageName: "design",
          bindings: { sketch: { ...persona, skills: [] } },
        },
        "sketch",
      ).skills.every((s) => s.installId === "core1"),
    ).toBe(true);
    expect(
      resolvePackageSession(
        {
          ...run,
          flowPackageName: "design",
          bindings: { sketch: { ...persona, skills: undefined } },
        },
        "sketch",
      ).skills.map((s) => s.slug),
    ).toContain("design");
  });

  it("refuses ambiguous library bytes and gives each session agent a stable private logical owner", () => {
    expect(() =>
      resolvePackageSession(
        { ...run, packages: [core, { ...design, shareSkills: true }, dev] },
        "build",
      ),
    ).toThrow(/common/);
    expect(sessionNameForPackageNode(run, "sketch", "main")).not.toBe("main");
    expect(sessionNameForPackageNode(run, "sketch", "main")).toBe(
      sessionNameForPackageNode(run, "sketch", "main"),
    );
    expect(sessionNameForPackageNode(run, "build", "main")).toBe("main");
  });
});

it("hashes executable HTTP and stdio targets with JSONB-equivalent optional metadata and overlays", () => {
  const pins = [
    packageMcpMaterial(
      { id: "remote", transport: "http", url: "https://example.com/api" },
      "cut",
    ),
    packageMcpMaterial(
      { id: "local", transport: "stdio", command: "server", args: ["--once"] },
      "cut",
    ),
  ];
  const records: CapabilityCatalogRecord[] = pins.map((material, i) => ({
    id: String(i),
    projectId: "p",
    capabilityRefId: i === 0 ? "remote" : "local",
    kind: "mcp",
    source: "flow-package",
    material,
    label: "MCP",
    version: "1",
    revision: "cut",
    agents: ["claude"],
    selectedByDefault: true,
    selectable: true,
    enforceability: "instructed",
  }));
  const refs = records.map((r) => r.capabilityRefId);
  const serialized = agentMcpTargets(
    refs,
    records,
    [],
    new Map([["remote", { headerRemap: { TOKEN: "env:KEY" } }]]),
  );
  const assembled = agentMcpTargets(
    refs,
    records.map((r) => ({
      ...r,
      material: { ...r.material, recommendedPlatformServerId: undefined },
    })),
    [],
    new Map([
      ["remote", { headerRemap: { TOKEN: "env:KEY" }, urlOverride: undefined }],
    ]),
  );

  expect(assembled).toEqual(serialized);
  expect(serialized[0]!.materialSha256).not.toEqual(
    serialized[1]!.materialSha256,
  );
  expect(assembled).not.toEqual(
    agentMcpTargets(
      refs,
      records,
      [],
      new Map([["remote", { headerRemap: { TOKEN: "env:OTHER" } }]]),
    ),
  );
});
