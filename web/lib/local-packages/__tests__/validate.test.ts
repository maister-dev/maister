import { describe, expect, it } from "vitest";

import {
  validatePackageArtifacts,
  type PackageArtifactFile,
} from "@/lib/local-packages/validate";

// (M39 ADR-105, Phase A3) The commit-time validation gate is pure: given the
// working-dir files + the paths THIS commit changes, it returns the invalid
// changed artifacts (flow parse+compile / manifest / platform-agent strict /
// skill SKILL.md). Capability subagents stay freeform until A4. Validation is
// scoped to `changedPaths`, never the whole tree.

const VALID_FLOW = `schemaVersion: 1
name: demo
steps:
  - id: s1
    type: cli
    command: echo hi
`;

const VALID_MANIFEST = `schemaVersion: 1
name: my-pkg
flows:
  - id: bugfix
    path: flows/bugfix
`;

const VALID_SKILL = `---
name: my-skill
description: does a thing
---
the skill body
`;

function changedAll(files: PackageArtifactFile[]) {
  return validatePackageArtifacts({
    files,
    changedPaths: files.map((f) => f.path),
  });
}

describe("validatePackageArtifacts", () => {
  it("passes a clean package (valid flow + manifest + skill)", () => {
    const errors = changedAll([
      { path: "maister-package.yaml", content: VALID_MANIFEST },
      { path: "flows/bugfix/flow.yaml", content: VALID_FLOW },
      { path: "skills/foo/SKILL.md", content: VALID_SKILL },
    ]);

    expect(errors).toEqual([]);
  });

  it("rejects a flow.yaml that does not compile", () => {
    const errors = changedAll([
      { path: "flows/bugfix/flow.yaml", content: "name: demo\n" },
    ]);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.path).toBe("flows/bugfix/flow.yaml");
  });

  it("rejects unparseable flow YAML", () => {
    const errors = changedAll([
      { path: "flow.yaml", content: ":\n  - bad: [" },
    ]);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.path).toBe("flow.yaml");
  });

  it("accepts a manifest with zero flows (empty/draft packages are valid — ADR-105)", () => {
    const errors = changedAll([
      {
        path: "maister-package.yaml",
        content: "schemaVersion: 1\nname: x\nflows: []\n",
      },
    ]);

    expect(errors).toEqual([]);
  });

  it("rejects a platform-agent definition with no frontmatter", () => {
    const fromMaisterAgents = changedAll([
      { path: "maister-agents/bad.md", content: "# Bad agent\nno fm\n" },
    ]);
    const fromAgents = changedAll([
      { path: "agents/bad.md", content: "# Bad agent\nno fm\n" },
    ]);

    expect(fromMaisterAgents.length).toBeGreaterThan(0);
    expect(fromAgents.length).toBeGreaterThan(0);
  });

  it("rejects a skill bundle file whose SKILL.md is absent", () => {
    const errors = validatePackageArtifacts({
      files: [{ path: "skills/foo/reference.md", content: "ref\n" }],
      changedPaths: ["skills/foo/reference.md"],
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("SKILL.md");
  });

  it("rejects a SKILL.md missing required frontmatter", () => {
    const errors = changedAll([
      { path: "skills/foo/SKILL.md", content: "just a body, no frontmatter\n" },
    ]);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.path).toBe("skills/foo/SKILL.md");
  });

  it("validates a capability subagent leniently (M39 A4)", () => {
    const bad = changedAll([
      { path: "capability/x/agents/helper.md", content: "no frontmatter\n" },
    ]);

    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]?.path).toBe("capability/x/agents/helper.md");

    const ok = changedAll([
      {
        path: "capability/x/agents/helper.md",
        content:
          "---\nname: helper\ndescription: helps\nmodel: inherit\ntools: Read, Bash\nfavorite: blue\n---\nbody\n",
      },
    ]);

    // Lenient + open: tools/custom keys are fine; name + description suffice.
    expect(ok).toEqual([]);
  });

  it("validates ONLY changed paths — an unchanged invalid flow is ignored", () => {
    const errors = validatePackageArtifacts({
      files: [
        { path: "maister-package.yaml", content: VALID_MANIFEST },
        { path: "flows/bugfix/flow.yaml", content: "name: broken\n" },
      ],
      changedPaths: ["maister-package.yaml"],
    });

    expect(errors).toEqual([]);
  });

  it("does NOT treat a bare flows/*.yaml or an aux yaml in a flow dir as a flow", () => {
    const bareUnderFlows = changedAll([
      { path: "flows/notes.yaml", content: "name: not-a-flow\n" },
    ]);
    const auxInFlowDir = changedAll([
      { path: "flows/bugfix/schema.yaml", content: "anything: here\n" },
    ]);

    expect(bareUnderFlows).toEqual([]);
    expect(auxInFlowDir).toEqual([]);
  });

  it("skips a deleted changed path (absent from files)", () => {
    const errors = validatePackageArtifacts({
      files: [],
      changedPaths: ["flows/bugfix/flow.yaml"],
    });

    expect(errors).toEqual([]);
  });
});
