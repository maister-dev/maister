import { describe, it, expect } from "vitest";

import { groupPackages } from "./group-packages";

function base() {
  return {
    id: "i1",
    name: "aif",
    sourceUrl: "github.com/org/aif",
    versionLabel: "v1.0.0",
    trustStatus: "trusted_by_policy",
    counts: { flows: 2, skills: 1, agents: 0, mcps: 0, rules: 0 },
  };
}

const inst = (o: Partial<ReturnType<typeof base>> = {}) => ({
  ...base(),
  ...o,
});

describe("groupPackages", () => {
  it("groups installs by (sourceUrl, name) and counts member artifacts", () => {
    const groups = groupPackages({
      installs: [inst(), inst({ id: "i2", versionLabel: "v1.1.0" })],
      attachments: [{ packageInstallId: "i1", projectId: "p1" }],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("aif");
    expect(groups[0].versions.map((v) => v.versionLabel)).toEqual([
      "v1.1.0",
      "v1.0.0",
    ]); // newest first
    expect(groups[0].counts).toEqual({
      flows: 2,
      skills: 1,
      agents: 0,
      mcps: 0,
      rules: 0,
    });
    expect(groups[0].attachedProjectCount).toBe(1);
  });

  it("flags a local source with the isLocal badge", () => {
    const groups = groupPackages({
      installs: [inst({ sourceUrl: "file:///x", versionLabel: "local-dev" })],
      attachments: [],
    });

    expect(groups[0].isLocal).toBe(true);
  });

  it("marks needs-attention when an install is untrusted", () => {
    const groups = groupPackages({
      installs: [inst({ trustStatus: "untrusted" })],
      attachments: [],
    });

    expect(groups[0].needsTrust).toBe(true);
  });
});
