import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { maisterPackageManifestSchema } from "@/lib/config.schema";

// ADR-165 AC-37 (the static half) + the fixture's own load contract.
//
// The in-repo `rah-fixture` package is what the integration matrix and the e2e
// drive. Two things must hold, and both are asserted here rather than inferred
// from a green matrix:
//
//   1. every manifest LOADS through the real loader (a fixture that silently
//      stopped compiling would take the matrix down with an unrelated message);
//   2. the safety properties the reference workflow claims are STRUCTURAL —
//      one writer, no subagent tool, no writable child — not merely observed in
//      one recorded run.

const ROOT = resolve(__dirname, "../../test-fixtures/rah");
const FLOWS = [
  "rah-root-d1",
  "rah-root-d2",
  "rah-research",
  "single-agent",
  "externalized-context",
] as const;

function manifestPath(flow: string): string {
  return join(ROOT, "flows", flow, "flow.yaml");
}

function rawManifest(flow: string): Record<string, unknown> {
  return parseYaml(readFileSync(manifestPath(flow), "utf8")) as Record<
    string,
    unknown
  >;
}

type Node = {
  id: string;
  type: string;
  settings?: {
    enforcement?: { tools?: string };
    tools?: Record<string, string[]>;
    delegation?: Record<string, unknown>;
  };
  output?: { result?: { schema?: string; required?: boolean } };
};

function nodesOf(flow: string): Node[] {
  return (rawManifest(flow).nodes ?? []) as Node[];
}

describe("rah fixture — the package manifest", () => {
  const pkg = parseYaml(
    readFileSync(join(ROOT, "maister-package.yaml"), "utf8"),
  );

  it("parses through the real package schema", () => {
    expect(maisterPackageManifestSchema.safeParse(pkg).success).toBe(true);
  });

  it("declares the `research` result profile against a package-root schema", () => {
    expect(maisterPackageManifestSchema.parse(pkg).result_profiles).toEqual({
      research: { schema: "./schemas/research-result.v1.json" },
    });
  });

  it("lists every flow directory that exists", () => {
    const listed = maisterPackageManifestSchema
      .parse(pkg)
      .flows.map((f) => f.id)
      .sort();

    expect(listed).toEqual([...FLOWS].sort());
  });
});

describe("rah fixture — every manifest loads", () => {
  it.each(FLOWS)("%s loads through loadFlowManifest", async (flow) => {
    await expect(loadFlowManifest(manifestPath(flow))).resolves.toBeTruthy();
  });

  it.each(FLOWS)("%s declares the 3.7.0 engine floor", (flow) => {
    expect(
      (rawManifest(flow).compat as { engine_min?: string } | undefined)
        ?.engine_min,
    ).toBe("3.7.0");
  });
});

describe("rah fixture — result contracts", () => {
  it("rah-research exports its result, so it can finish by result-only completion", async () => {
    const manifest = await loadFlowManifest(manifestPath("rah-research"));
    const exported = (
      manifest as {
        result?: {
          export?: { schema: string; from: string[]; required: boolean };
        };
      }
    ).result?.export;

    expect(exported).toEqual({
      schema: "./schemas/research-result.v1.json",
      from: ["orchestrate"],
      required: true,
    });
  });

  it("its producer's output.result is FORCED required by the required export", async () => {
    const manifest = await loadFlowManifest(manifestPath("rah-research"));
    const orchestrate = (manifest.nodes ?? []).find(
      (n) => n.id === "orchestrate",
    );

    expect(orchestrate?.output?.result?.required).toBe(true);
  });

  it("the root graphs export NOTHING — they promote a diff instead", () => {
    for (const flow of ["rah-root-d1", "rah-root-d2"] as const) {
      expect(rawManifest(flow).result).toBeUndefined();
    }
  });
});

// AC-37 static assertions: the safety claims of D15/D16, as properties of the
// fixture rather than of one observed run.
describe("rah fixture — structural safety (AC-37)", () => {
  const HARNESS_FLOWS = ["rah-root-d1", "rah-root-d2", "rah-research"] as const;
  // The adapter-internal subagent tools. Admitting one would let a coordinator
  // spawn work that is not governed, not budgeted and not collectable — which
  // is exactly what the delegation toolset exists to replace.
  const SUBAGENT_TOOLS = ["Task", "Agent", "Subagent"];

  it.each(HARNESS_FLOWS)(
    "%s: every orchestrator declares enforcement.tools strict",
    (flow) => {
      const orchestrators = nodesOf(flow).filter(
        (n) => n.type === "orchestrator",
      );

      expect(orchestrators.length).toBeGreaterThan(0);
      for (const node of orchestrators) {
        expect(node.settings?.enforcement?.tools).toBe("strict");
      }
    },
  );

  it.each(HARNESS_FLOWS)(
    "%s: no orchestrator's tools allow-list contains a subagent tool",
    (flow) => {
      for (const node of nodesOf(flow).filter(
        (n) => n.type === "orchestrator",
      )) {
        const allowed = Object.values(node.settings?.tools ?? {}).flat();

        expect(allowed.length).toBeGreaterThan(0);
        for (const tool of SUBAGENT_TOOLS) {
          expect(allowed).not.toContain(tool);
        }
      }
    },
  );

  it.each(HARNESS_FLOWS)(
    "%s: every orchestrator declares a COMPLETE delegation budget",
    (flow) => {
      for (const node of nodesOf(flow).filter(
        (n) => n.type === "orchestrator",
      )) {
        const budget = node.settings?.delegation?.budget as
          | Record<string, number>
          | undefined;

        expect(budget).toBeDefined();
        for (const key of [
          "max_tokens",
          "wall_clock_minutes",
          "max_child_runs",
          "consecutive_failures",
        ]) {
          expect(typeof budget?.[key]).toBe("number");
        }
      }
    },
  );

  it("every researcher agent is read-only (workspace: repo_read)", () => {
    for (const stem of [
      "architecture-researcher",
      "dependency-researcher",
      "test-researcher",
      "risk-researcher",
    ]) {
      const body = readFileSync(
        join(ROOT, "maister-agents", `${stem}.md`),
        "utf8",
      );

      expect(body).toContain("workspace: repo_read");
      expect(body).toContain("risk_tier: read_only");
      // No fixture agent declares `workspace: worktree` — a writable child is
      // what would reintroduce the concurrent-writer problem the ONE-writer
      // shape exists to avoid.
      expect(body).not.toContain("workspace: worktree");
    }
  });

  it("the root graphs have EXACTLY ONE worktree-writing node", () => {
    for (const flow of ["rah-root-d1", "rah-root-d2"] as const) {
      const writers = nodesOf(flow).filter((n) => n.type === "ai_coding");

      expect(writers.map((n) => n.id)).toEqual(["writer"]);
    }
  });

  it("rah-research has NO writer at all — it only reads and reports", () => {
    expect(
      nodesOf("rah-research").filter((n) => n.type === "ai_coding"),
    ).toHaveLength(0);
  });

  it("the depth bound stops the recursion: d1 declares 1, d2 declares 2", () => {
    const depth = (flow: string): unknown =>
      nodesOf(flow).find((n) => n.type === "orchestrator")?.settings?.delegation
        ?.max_depth;

    expect(depth("rah-root-d1")).toBe(1);
    expect(depth("rah-root-d2")).toBe(2);
    // `max_depth` counts ABSOLUTE depth from the tree root and admission
    // min-merges the parent's declaration with the root's, so a nested flow must
    // declare the depth its OWN children will occupy in the whole tree — 2, not
    // the 1 level it adds. Declaring 1 here would refuse every researcher the
    // moment `rah-research` runs as a child of `rah-root-d2`.
    expect(depth("rah-research")).toBe(2);
  });

  it("the verifier is a judge behind a BLOCKING gate, not an advisory one", () => {
    for (const flow of ["rah-root-d1", "rah-root-d2"] as const) {
      const verify = (
        rawManifest(flow).nodes as Record<string, unknown>[]
      ).find((n) => n.id === "verify") as
        | { type: string; pre_finish?: { gates?: { mode?: string }[] } }
        | undefined;

      expect(verify?.type).toBe("judge");
      expect(verify?.pre_finish?.gates?.[0]?.mode).toBe("blocking");
    }
  });
});
