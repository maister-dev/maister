import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { isMaisterError } from "@/lib/errors";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "config-artifacts-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeFixture(name: string, content: string): Promise<string> {
  const path = join(workDir, name);

  await writeFile(path, content, "utf8");

  return path;
}

type GraphManifest = {
  schemaVersion: number;
  name: string;
  compat: { engine_min: string };
  nodes: Array<Record<string, unknown>>;
};

function baseGraphManifest(): GraphManifest {
  return {
    schemaVersion: 1,
    name: "aif",
    compat: { engine_min: "1.2.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/aif-implement {{ task.prompt }}" },
        output: {
          produces: [
            {
              id: "implementation-diff",
              kind: "diff",
            },
          ],
        },
        transitions: { success: "test" },
      },
      {
        id: "test",
        type: "check",
        action: { command: "pnpm test" },
        pre_finish: {
          gates: [
            {
              id: "test-gate",
              kind: "command_check",
              mode: "blocking",
              command: "pnpm test",
            },
          ],
        },
        output: {
          produces: [
            {
              id: "test-results",
              kind: "test_report",
              path: "test-output.json",
              retention: "run",
              requiredFor: ["review"],
            },
          ],
        },
        transitions: { success: "review" },
      },
      {
        id: "review",
        type: "human",
        finish: { human: { decisions: ["approve", "rework"] } },
        transitions: { approve: "done", rework: "implement" },
        rework: {
          allowedTargets: ["implement"],
          workspacePolicies: ["keep"],
          maxLoops: 3,
          commentsVar: "review_comments",
        },
      },
    ],
  };
}

async function writeGraph(
  name: string,
  mutate: (m: GraphManifest) => void = () => {},
): Promise<string> {
  const m = structuredClone(baseGraphManifest());

  mutate(m);

  return writeFixture(name, stringifyYaml(m));
}

describe("validateGraphManifest — artifact validation (M12 Phase 2)", () => {
  it("accepts a fully valid graph with engine_min 1.2.0 and typed artifacts", async () => {
    const path = await writeGraph("valid-artifacts.yaml");
    const manifest = await loadFlowManifest(path);

    expect(manifest.name).toBe("aif");
    expect(manifest.nodes).toHaveLength(3);
    expect(manifest.nodes![0].output?.produces).toHaveLength(1);
    expect(manifest.nodes![1].output?.produces).toHaveLength(1);
  });

  describe("validation rule 1: duplicate produces id across nodes", () => {
    it("rejects duplicate produces id between nodes", async () => {
      const path = await writeGraph("dup-produces-id.yaml", (m) => {
        // Both implement and test produce "implementation-diff"
        (m.nodes[1].output as any).produces[0].id = "implementation-diff";
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
      const msg = caught instanceof Error ? caught.message : "";

      expect(msg).toMatch(/duplicate.*produces.*id/i);
    });
  });

  describe("validation rule 2: input.requires artifact ref not in registry", () => {
    it("rejects a bare string in input.requires that is not in the produces registry", async () => {
      const path = await writeGraph("requires-ghost-artifact.yaml", (m) => {
        // test node requires a "lint-results" that no node produces
        (m.nodes[1] as any).input = {
          requires: ["lint-results"],
        };
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
      const msg = caught instanceof Error ? caught.message : "";

      expect(msg).toMatch(/input\.requires.*references unknown.*lint-results/i);
    });

    it("rejects an object {artifact:<id>} in input.requires whose id is not in registry", async () => {
      const path = await writeGraph("requires-ghost-artifact-obj.yaml", (m) => {
        // review node requires an artifact that doesn't exist
        (m.nodes[2] as any).input = {
          requires: [{ artifact: "nonexistent-report", kind: "test_report" }],
        };
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
      const msg = caught instanceof Error ? caught.message : "";

      expect(msg).toMatch(
        /input\.requires.*references unknown.*nonexistent-report/i,
      );
    });

    it("accepts input.requires with a valid artifact id from the produces registry", async () => {
      const path = await writeGraph("requires-valid-artifact.yaml", (m) => {
        // review node requires test-results that is produced by test node
        (m.nodes[2] as any).input = {
          requires: ["test-results"],
        };
      });

      const manifest = await loadFlowManifest(path);

      expect(manifest.nodes![2].input?.requires).toContain("test-results");
    });

    it("rejects an object {artifact,kind} whose kind mismatches the produced kind", async () => {
      const path = await writeGraph("requires-kind-mismatch.yaml", (m) => {
        // test-results is produced as kind "test_report"; declare it as "log".
        (m.nodes[2] as any).input = {
          requires: [{ artifact: "test-results", kind: "log" }],
        };
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
      const msg = caught instanceof Error ? caught.message : "";

      expect(msg).toMatch(/declares kind "log".*produced as "test_report"/i);
    });

    it("accepts an object {artifact,kind} whose kind matches the produced kind", async () => {
      const path = await writeGraph("requires-kind-match.yaml", (m) => {
        (m.nodes[2] as any).input = {
          requires: [{ artifact: "test-results", kind: "test_report" }],
        };
      });

      const manifest = await loadFlowManifest(path);

      expect(manifest.nodes![2].input?.requires).toEqual([
        { artifact: "test-results", kind: "test_report" },
      ]);
    });

    it("accepts steps.* templating refs in input.requires (M11a backward compat)", async () => {
      const path = await writeGraph("requires-steps-template.yaml", (m) => {
        // Node accepting a steps.* templating ref (not a typed artifact)
        (m.nodes[2] as any).input = {
          requires: ["steps.test.output.test-results"],
        };
      });

      const manifest = await loadFlowManifest(path);

      expect(manifest.nodes![2].input?.requires).toContain(
        "steps.test.output.test-results",
      );
    });
  });

  describe("validation rule 3: unsupported produces kind", () => {
    it("rejects produces with an invalid kind value", async () => {
      const path = await writeGraph("invalid-produces-kind.yaml", (m) => {
        (m.nodes[0].output as any).produces[0].kind = "bogus_artifact_kind";
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
    });
  });

  describe("validation rule 4: invalid produces path or ref", () => {
    it("rejects produces path that escapes the run directory (..)", async () => {
      const path = await writeGraph("produces-path-escape.yaml", (m) => {
        (m.nodes[0].output as any).produces[0].path = "../../etc/passwd";
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
    });

    it("rejects produces path that is absolute", async () => {
      const path = await writeGraph("produces-path-absolute.yaml", (m) => {
        (m.nodes[0].output as any).produces[0].path = "/etc/passwd";
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
    });

    it("rejects produces with an empty path string (resolves to the run dir)", async () => {
      const path = await writeGraph("produces-path-empty.yaml", (m) => {
        (m.nodes[0].output as any).produces[0].path = "";
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
      const msg = caught instanceof Error ? caught.message : "";

      expect(msg).toMatch(/non-empty relative file path/i);
    });

    it("rejects produces with a bare-dot path", async () => {
      const path = await writeGraph("produces-path-dot.yaml", (m) => {
        (m.nodes[0].output as any).produces[0].path = ".";
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
    });

    it("rejects produces with a directory-like trailing-slash path", async () => {
      const path = await writeGraph("produces-path-dir.yaml", (m) => {
        (m.nodes[0].output as any).produces[0].path = "outputs/";
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
    });

    it("rejects produces with empty ref string", async () => {
      const path = await writeGraph("produces-ref-empty.yaml", (m) => {
        (m.nodes[0].output as any).produces[0].ref = "";
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
    });

    it("accepts valid relative path in produces", async () => {
      const path = await writeGraph("produces-path-valid.yaml", (m) => {
        (m.nodes[0].output as any).produces[0].path = "outputs/diff.json";
      });

      const manifest = await loadFlowManifest(path);

      expect(manifest.nodes![0].output?.produces![0].path).toBe(
        "outputs/diff.json",
      );
    });
  });

  describe("validation rule 5: artifact_required gate with unknown inputArtifacts", () => {
    it("rejects an artifact_required gate whose inputArtifacts references non-existent artifact", async () => {
      const path = await writeGraph("gate-artifact-ghost.yaml", (m) => {
        // Add an artifact_required gate that references a non-existent artifact
        (m.nodes[1].pre_finish as any).gates = [
          {
            id: "artifact-check",
            kind: "artifact_required",
            mode: "blocking",
            inputArtifacts: ["nonexistent-artifact"],
          },
        ];
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
      const msg = caught instanceof Error ? caught.message : "";

      expect(msg).toMatch(
        /artifact_required.*inputArtifacts.*references unknown/i,
      );
    });

    it("accepts an artifact_required gate whose inputArtifacts are in the registry", async () => {
      const path = await writeGraph("gate-artifact-valid.yaml", (m) => {
        (m.nodes[1].pre_finish as any).gates = [
          {
            id: "artifact-check",
            kind: "artifact_required",
            mode: "blocking",
            inputArtifacts: ["test-results"],
          },
        ];
      });

      const manifest = await loadFlowManifest(path);
      const gates = manifest.nodes![1].pre_finish?.gates ?? [];

      expect(gates.some((g) => g.kind === "artifact_required")).toBe(true);
    });
  });

  describe("engine-gate rule: declared artifacts require engine_min >= 1.2.0", () => {
    it("rejects a manifest declaring artifacts while engine_min < 1.2.0", async () => {
      const path = await writeGraph("artifacts-old-engine.yaml", (m) => {
        m.compat.engine_min = "1.1.0"; // Too old for artifacts
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
      const msg = caught instanceof Error ? caught.message : "";

      expect(msg).toMatch(
        /declaring artifacts.*engine_min.*1\.2\.0|artifacts.*requires.*engine/i,
      );
    });

    it("rejects a manifest with artifact-typed input.requires while engine_min < 1.2.0", async () => {
      const path = await writeGraph(
        "artifact-requires-old-engine.yaml",
        (m) => {
          m.compat.engine_min = "1.1.0";
          (m.nodes[1] as any).input = {
            requires: [{ artifact: "test-results", kind: "test_report" }],
          };
        },
      );

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
    });

    it("rejects a manifest with artifact_required gate while engine_min < 1.2.0", async () => {
      const path = await writeGraph("artifact-gate-old-engine.yaml", (m) => {
        m.compat.engine_min = "1.1.0";
        (m.nodes[0].pre_finish as any) = {
          gates: [
            {
              id: "artifact-check",
              kind: "artifact_required",
              mode: "blocking",
              inputArtifacts: ["implementation-diff"],
            },
          ],
        };
      });

      let caught: unknown;

      try {
        await loadFlowManifest(path);
      } catch (e) {
        caught = e;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect((caught as any).code).toBe("CONFIG");
    });

    it("accepts engine_min >= 1.2.0 with artifacts declared", async () => {
      const path = await writeGraph("artifacts-new-engine.yaml", (m) => {
        m.compat.engine_min = "1.2.0";
      });

      const manifest = await loadFlowManifest(path);

      expect(manifest.compat?.engine_min).toBe("1.2.0");
      expect(manifest.nodes![0].output?.produces).toBeDefined();
    });
  });

  describe("backward compat: graph with no artifacts at all", () => {
    it("accepts a graph without any produces/artifact-requires/artifact gates, engine_min 1.1.0", async () => {
      const path = await writeGraph("no-artifacts-old-engine.yaml", (m) => {
        m.compat.engine_min = "1.1.0";
        // Remove all produces declarations
        m.nodes.forEach((n) => {
          delete n.output;
        });
      });

      const manifest = await loadFlowManifest(path);

      expect(manifest.compat?.engine_min).toBe("1.1.0");
    });
  });
});
