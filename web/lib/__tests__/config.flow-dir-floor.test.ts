import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { isMaisterError } from "@/lib/errors";

// ADR-154: a cli/check `action.command` that references MAISTER_FLOW_DIR
// executes packaged files from the flow install dir — the var exists only on
// engines >= 3.3.0, so the manifest must declare that floor. Load-time scan
// mirrors the ADR-120 `{{ artifacts.*.content }}` precedent: detect the
// dependency in the authored text, refuse with CONFIG before install.

describe("ADR-154 — MAISTER_FLOW_DIR engine floor gate", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "flow-dir-floor-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function load(
    manifest: unknown,
  ): Promise<{ ok: boolean; code?: string; message?: string }> {
    const path = join(workDir, "flow.yaml");

    await writeFile(path, stringifyYaml(manifest), "utf8");
    try {
      await loadFlowManifest(path);

      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        code: isMaisterError(err) ? err.code : "UNKNOWN",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function manifest(opts: {
    engineMin?: string;
    nodeType?: "cli" | "check" | "ai_coding";
    command?: string;
  }): unknown {
    const nodeType = opts.nodeType ?? "check";
    const node: Record<string, unknown> = {
      id: "step",
      type: nodeType,
      transitions: { success: "done" },
    };

    if (nodeType === "cli" || nodeType === "check") {
      node.action = { command: opts.command ?? "true" };
    } else {
      node.action = { prompt: opts.command ?? "do the thing" };
    }

    const compat = opts.engineMin ? { engine_min: opts.engineMin } : undefined;

    return {
      schemaVersion: 1,
      name: "flow-dir-floor-fixture",
      ...(compat ? { compat } : {}),
      nodes: [node],
    };
  }

  const FLOW_DIR_COMMAND =
    'bash "${MAISTER_FLOW_DIR:?engine too old}/scripts/run.sh"';

  it("refuses a check command using MAISTER_FLOW_DIR below the 3.3.0 floor", async () => {
    const result = await load(
      manifest({ engineMin: "3.0.0", command: FLOW_DIR_COMMAND }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIG");
    expect(result.message).toContain("MAISTER_FLOW_DIR");
    expect(result.message).toContain("3.3.0");
  });

  it("leaves command_check gate commands out of the scan (ADR-154 scope v1: node actions only)", async () => {
    const base = manifest({
      nodeType: "cli",
      engineMin: "1.1.0",
      command: "echo ok",
    }) as { nodes: Array<Record<string, unknown>> };

    base.nodes[0].pre_finish = {
      gates: [
        {
          id: "g1",
          kind: "command_check",
          mode: "blocking",
          command: FLOW_DIR_COMMAND,
        },
      ],
    };

    const result = await load(base);

    expect(result.ok).toBe(true);
  });

  it("accepts MAISTER_FLOW_DIR commands at engine_min 3.3.0", async () => {
    const result = await load(
      manifest({ engineMin: "3.3.0", command: FLOW_DIR_COMMAND }),
    );

    expect(result.ok).toBe(true);
  });

  it("leaves plain cli commands ungated at low floors", async () => {
    const result = await load(
      manifest({ nodeType: "cli", engineMin: "1.1.0", command: "echo ok" }),
    );

    expect(result.ok).toBe(true);
  });

  it("ignores MAISTER_FLOW_DIR prose in agent prompts (scan is cli/check commands only)", async () => {
    const result = await load(
      manifest({
        nodeType: "ai_coding",
        engineMin: "1.1.0",
        command: "explain what MAISTER_FLOW_DIR does",
      }),
    );

    expect(result.ok).toBe(true);
  });
});
