import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadFlowManifest } from "@/lib/config";

// The five shipped AIF flow graphs live outside web/ (package content). Resolved
// from the repo root. loadFlowManifest parses flowYamlV1Schema AND runs
// validateGraphManifest (transitions resolve, no unknown goto, bounded cycles,
// artifact rules) — so a non-throwing load is the full regression guard (T7).
const here = dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = resolve(here, "../../../plugins/aif/flows");
const FLOWS = ["dev", "bugfix", "evolve", "roadmap", "init"] as const;

describe("aif flow package — shipped flow graphs (T7)", () => {
  it("ships exactly the five designed flow directories", () => {
    const dirs = readdirSync(FLOWS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    expect(dirs).toEqual([...FLOWS].sort());
  });

  it.each(FLOWS)(
    "%s/flow.yaml passes flowYamlV1Schema + graph validation",
    async (flow) => {
      const manifest = await loadFlowManifest(
        join(FLOWS_DIR, flow, "flow.yaml"),
      );

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.name).toBe(`aif-${flow}`);
      expect((manifest.nodes ?? []).length).toBeGreaterThan(0);
      // T3 metadata + provenance present on every shipped flow.
      expect((manifest.metadata?.labels ?? []).length).toBeGreaterThan(0);
      expect((manifest.metadata?.links ?? []).length).toBeGreaterThan(0);
    },
  );

  it("aif-dev opens with the form intake node and a terminal commit", async () => {
    const manifest = await loadFlowManifest(
      join(FLOWS_DIR, "dev", "flow.yaml"),
    );
    const nodes = manifest.nodes ?? [];

    expect(nodes[0]?.id).toBe("intake");
    expect(nodes[0]?.type).toBe("form");

    const commit = nodes.find((n) => n.id === "commit");

    expect(commit?.transitions?.success).toBe("done");
    expect(
      (commit?.pre_finish?.gates ?? []).some((g) => g.kind === "command_check"),
    ).toBe(true);
  });
});
