import { describe, expect, it } from "vitest";

import { installCapabilityRevision } from "@/lib/capabilities/import";
import { isMaisterError } from "@/lib/errors";

// ADR-087 boundary: an invalid resolvedRevisionOverride is rejected BEFORE
// any fs/git/db side-effect (the dummy db object would throw if touched).
describe("installCapabilityRevision resolvedRevisionOverride boundary", () => {
  it.each([
    ["non-hex", "not-a-revision"],
    ["short hex", "abcdef"],
    ["unknown sentinel", "unknown"],
  ])("rejects %s override with FLOW_INSTALL", async (_label, override) => {
    try {
      await installCapabilityRevision({
        source: "file:///tmp/nonexistent-package-dir",
        version: "local-dev",
        capabilityRefId: "bundle",
        projectId: "11111111-1111-1111-1111-111111111111",
        resolvedRevisionOverride: override,
        // FIXME(any): dummy db — the boundary throw happens before any use.
        db: {} as never,
      });
      throw new Error("expected installCapabilityRevision to throw");
    } catch (err) {
      if (!isMaisterError(err)) throw err;
      expect(err.code).toBe("FLOW_INSTALL");
      expect(err.message).toMatch(/Invalid resolvedRevisionOverride/);
    }
  });
});
