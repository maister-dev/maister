import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import { flowManifestIncompatibilityDetails } from "@/lib/flows/manifest-parser";
import { packageCompatibilityReasonFromError } from "@/lib/queries/packages";

describe("packageCompatibilityReasonFromError", () => {
  it("keeps a typed legacy classification when the presentation message changes", () => {
    const error = new MaisterError("CONFIG", "Reworded presentation text", {
      details: flowManifestIncompatibilityDetails({
        kind: "legacy_steps",
        message: "Reworded presentation text",
      }),
    });

    expect(packageCompatibilityReasonFromError(error)).toEqual({
      compatible: false,
      incompatibilityReason:
        "legacy steps[] flows are not supported since engine 3.0.0; republish the package with nodes[]",
    });
  });
});
