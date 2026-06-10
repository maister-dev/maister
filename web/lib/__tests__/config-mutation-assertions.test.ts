// TC.1 (M29/ADR-074): gate mutation assertions schema + widened 1.3.0 engine
// floor + `mutation_report` kind fan-out. Mirrors config-artifacts.test.ts:
// tmp-dir YAML fixtures loaded through loadFlowManifest, asserting
// MaisterError("CONFIG") with precise messages.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import {
  ARTIFACT_KINDS,
  restrictionCapabilitySchema,
} from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-mutation-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

type GraphManifest = {
  schemaVersion: number;
  name: string;
  compat: { engine_min: string };
  nodes: Array<Record<string, unknown>>;
};

// One ai_coding node producing a diff + an artifact_required gate carrying the
// mutation assertions under test. engine_min is mutated per case.
function baseManifest(): GraphManifest {
  return {
    schemaVersion: 1,
    name: "mutation",
    compat: { engine_min: "1.3.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "implement {{ task.prompt }}" },
        output: {
          produces: [{ id: "implementation-diff", kind: "diff" }],
        },
        pre_finish: {
          gates: [
            {
              id: "impl-mutation",
              kind: "artifact_required",
              mode: "blocking",
              inputArtifacts: ["implementation-diff"],
              must_touch: ["src/**"],
              must_not_touch: "restrictions",
              output: { id: "impl-mutation-report", kind: "mutation_report" },
            },
          ],
        },
        transitions: { success: "done" },
      },
    ],
  };
}

async function writeGraph(
  name: string,
  mutate: (m: GraphManifest) => void = () => {},
): Promise<string> {
  const m = structuredClone(baseManifest());

  mutate(m);
  const path = join(workDir, name);

  await writeFile(path, stringifyYaml(m), "utf8");

  return path;
}

function gateOf(m: GraphManifest): Record<string, unknown> {
  const preFinish = m.nodes[0].pre_finish as {
    gates: Array<Record<string, unknown>>;
  };

  return preFinish.gates[0];
}

async function expectConfig(path: string, ...needles: string[]): Promise<void> {
  let caught: unknown;

  try {
    await loadFlowManifest(path);
  } catch (e) {
    caught = e;
  }

  expect(isMaisterError(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe("CONFIG");
  const msg = caught instanceof Error ? caught.message : "";

  for (const needle of needles) {
    expect(msg).toContain(needle);
  }
}

describe("gate mutation assertions — schema shape (D-C1)", () => {
  it("accepts must_touch + must_not_touch + mutation_report output on artifact_required at 1.3.0", async () => {
    const path = await writeGraph("valid.yaml");
    const manifest = await loadFlowManifest(path);

    const gate = (
      manifest.nodes![0].pre_finish!.gates as Array<Record<string, unknown>>
    )[0];

    expect(gate.must_touch).toEqual(["src/**"]);
    expect(gate.must_not_touch).toBe("restrictions");
  });

  it("rejects must_touch on a non-artifact_required gate (command_check)", async () => {
    const path = await writeGraph("wrong-kind.yaml", (m) => {
      const gate = gateOf(m);

      gate.kind = "command_check";
      gate.command = "true";
      delete gate.inputArtifacts;
      delete gate.must_not_touch;
      delete gate.output;
    });

    await expectConfig(path, "artifact_required");
  });

  it("rejects must_not_touch with any value other than the literal 'restrictions'", async () => {
    const path = await writeGraph("bad-literal.yaml", (m) => {
      gateOf(m).must_not_touch = "src/**";
    });

    await expectConfig(path);
  });

  it("rejects an empty must_touch array (min 1 glob)", async () => {
    const path = await writeGraph("empty-globs.yaml", (m) => {
      gateOf(m).must_touch = [];
    });

    await expectConfig(path);
  });

  it("rejects gate output kind mutation_report when no assertions are declared", async () => {
    const path = await writeGraph("report-no-assertions.yaml", (m) => {
      const gate = gateOf(m);

      delete gate.must_touch;
      delete gate.must_not_touch;
    });

    await expectConfig(path, "mutation_report");
  });

  it("rejects a declared output of a different kind on an assertion-bearing gate", async () => {
    const path = await writeGraph("wrong-output-kind.yaml", (m) => {
      gateOf(m).output = { id: "impl-mutation-report", kind: "lint_report" };
    });

    await expectConfig(path, "mutation_report");
  });
});

describe("widened engine floor — mutation features require engine_min >= 1.3.0 (D-C6)", () => {
  it("rejects must_touch at engine_min 1.2.0 with the floor message", async () => {
    const path = await writeGraph("floor-must-touch.yaml", (m) => {
      m.compat.engine_min = "1.2.0";
      delete gateOf(m).must_not_touch;
      delete gateOf(m).output;
    });

    await expectConfig(path, "1.3.0", "1.2.0");
  });

  it("rejects must_not_touch at engine_min 1.2.0", async () => {
    const path = await writeGraph("floor-must-not-touch.yaml", (m) => {
      m.compat.engine_min = "1.2.0";
      delete gateOf(m).must_touch;
      delete gateOf(m).output;
    });

    await expectConfig(path, "1.3.0");
  });

  it("rejects gate output kind mutation_report at engine_min 1.2.0", async () => {
    const path = await writeGraph("floor-report-kind.yaml", (m) => {
      m.compat.engine_min = "1.2.0";
    });

    await expectConfig(path, "1.3.0");
  });

  it("accepts the same manifest at engine_min 1.3.0", async () => {
    const path = await writeGraph("floor-ok.yaml");
    const manifest = await loadFlowManifest(path);

    expect(manifest.compat?.engine_min).toBe("1.3.0");
  });

  it("keeps a manifest WITHOUT mutation features valid at engine_min 1.2.0 (back-compat)", async () => {
    const path = await writeGraph("no-mutation-1.2.0.yaml", (m) => {
      m.compat.engine_min = "1.2.0";
      const gate = gateOf(m);

      delete gate.must_touch;
      delete gate.must_not_touch;
      delete gate.output;
    });

    const manifest = await loadFlowManifest(path);

    expect(manifest.compat?.engine_min).toBe("1.2.0");
  });
});

describe("restriction `paths` (D-C2) and kind fan-out", () => {
  it("parses an optional paths array on a restriction capability", () => {
    const parsed = restrictionCapabilitySchema.parse({
      id: "no-engine-edits",
      content: "Do not modify the flow engine.",
      paths: ["web/lib/flows/graph/**", "web/lib/db/migrations/**"],
    });

    expect(parsed.paths).toEqual([
      "web/lib/flows/graph/**",
      "web/lib/db/migrations/**",
    ]);
  });

  it("keeps paths optional (absent → undefined)", () => {
    const parsed = restrictionCapabilitySchema.parse({
      id: "free-text-only",
      content: "Use the staging database only.",
    });

    expect(parsed.paths).toBeUndefined();
  });

  it("rejects empty-string path entries", () => {
    const result = restrictionCapabilitySchema.safeParse({
      id: "bad",
      paths: [""],
    });

    expect(result.success).toBe(false);
  });

  it("ARTIFACT_KINDS includes mutation_report", () => {
    expect(ARTIFACT_KINDS).toContain("mutation_report");
  });

  it("observatory artifactKind filter accepts mutation_report (derived fan-out)", () => {
    const parsed = parseObservatorySearchParams({
      artifactKind: "mutation_report",
    });

    expect(parsed.filters.artifactKind).toBe("mutation_report");
  });
});
