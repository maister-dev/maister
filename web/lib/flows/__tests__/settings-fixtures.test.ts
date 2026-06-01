import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadFlowManifest } from "@/lib/config";
import { assertNodeLaunchable } from "@/lib/flows/enforcement";
import { isMaisterError } from "@/lib/errors";

const FIXTURES = resolve(__dirname, "_fixtures");
const AIF_FLOW = resolve(__dirname, "../../../../plugins/aif/flow.yaml");

function capabilityNodes(
  manifest: Awaited<ReturnType<typeof loadFlowManifest>>,
) {
  return (manifest.nodes ?? []).filter(
    (n) => n.type === "ai_coding" || n.type === "judge",
  );
}

describe("M11c settings fixtures", () => {
  it("refuses the strict-refusal fixture at launch with CONFIG", async () => {
    const manifest = await loadFlowManifest(
      resolve(FIXTURES, "strict-refusal.flow.yaml"),
    );

    let caught: unknown;

    for (const node of capabilityNodes(manifest)) {
      try {
        assertNodeLaunchable(node, "claude");
      } catch (err) {
        caught = err;
      }
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("CONFIG");
    expect((caught as Error).message).toContain("implement");
    expect((caught as Error).message).toContain("mcps");
  });

  it("never refuses the settings-less greet fixture (AC-6)", async () => {
    const manifest = await loadFlowManifest(
      resolve(FIXTURES, "greet.flow.yaml"),
    );

    expect(capabilityNodes(manifest)).toHaveLength(0);
  });

  it("launches the all-instruct aif flow without refusal", async () => {
    const manifest = await loadFlowManifest(AIF_FLOW);

    for (const node of capabilityNodes(manifest)) {
      expect(() => assertNodeLaunchable(node, "claude")).not.toThrow();
      expect(() => assertNodeLaunchable(node, "codex")).not.toThrow();
    }
  });
});
