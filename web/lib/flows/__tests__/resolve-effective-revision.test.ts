import { describe, expect, it } from "vitest";

import { resolveEffectiveFlowRevision } from "@/lib/flows/lifecycle";

// T-B4 (Stage-1, ADR-068): both bindings resolve the per-project enabled
// pointer. Authored "latest" auto-follow is realized by the publish→bridge
// path updating flows.enabled_revision_id (T-B2), not by a launch-time query
// over the GLOBAL flow_revisions pool (which would mis-resolve across projects).
const stubDb = {} as never;

describe("resolveEffectiveFlowRevision (T-B4)", () => {
  it("resolves the enabled revision for pinned", async () => {
    const id = await resolveEffectiveFlowRevision(stubDb, {
      flowRefId: "bugfix",
      enabledRevisionId: "rev-1",
      versionBinding: "pinned",
    });

    expect(id).toBe("rev-1");
  });

  it("resolves the enabled revision for latest (bridge keeps the pointer newest)", async () => {
    const id = await resolveEffectiveFlowRevision(stubDb, {
      flowRefId: "bugfix",
      enabledRevisionId: "rev-9",
      versionBinding: "latest",
    });

    expect(id).toBe("rev-9");
  });

  it("passes a null enabled pointer through unchanged", async () => {
    const id = await resolveEffectiveFlowRevision(stubDb, {
      flowRefId: "bugfix",
      enabledRevisionId: null,
      versionBinding: "latest",
    });

    expect(id).toBeNull();
  });
});
