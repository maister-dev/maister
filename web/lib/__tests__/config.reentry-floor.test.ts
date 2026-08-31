import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { isMaisterError } from "@/lib/errors";

// T-A7 (AC-A7) — ADR-159: the flow-level `reentry` key names the node an
// operator's rework claim re-enters the graph at. It is compile-time only and
// is never persisted to a DB column, so the YAML->DB SET/CLEAR symmetry rule
// does not apply; the only obligations are the 3.5.0 engine floor, the
// resolves-to-a-known-node check, and byte-identical behaviour for manifests
// that do not declare it. The gate is on the MANIFEST, not on `nodes` — the
// key is flow-level.

describe("T-A7 ADR-159 — flow-level `reentry` engine floor and node resolution", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "reentry-floor-"));
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

  function manifest(opts: { engineMin?: string; reentry?: string }): unknown {
    const compat = opts.engineMin ? { engine_min: opts.engineMin } : undefined;

    return {
      schemaVersion: 1,
      name: "reentry-floor-fixture",
      ...(compat ? { compat } : {}),
      ...(opts.reentry !== undefined ? { reentry: opts.reentry } : {}),
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "do the thing" },
          transitions: { success: "verify" },
        },
        {
          id: "verify",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    };
  }

  it("refuses a `reentry` declaration below the 3.5.0 floor", async () => {
    const result = await load(
      manifest({ engineMin: "3.4.0", reentry: "verify" }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIG");
    expect(result.message).toContain("reentry");
    expect(result.message).toContain("3.5.0");
  });

  it("accepts `reentry` naming a known node at engine_min 3.5.0", async () => {
    const result = await load(
      manifest({ engineMin: "3.5.0", reentry: "verify" }),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a `reentry` naming a node absent from the graph, and names the id", async () => {
    const result = await load(
      manifest({ engineMin: "3.5.0", reentry: "no-such-node" }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("CONFIG");
    expect(result.message).toContain("no-such-node");
  });

  // Back-compat: the floor is on the DECLARATION, not on the engine version.
  // A manifest that never mentions `reentry` must load at any engine_min it
  // was already valid at.
  it("leaves a manifest without `reentry` ungated at a low floor", async () => {
    const result = await load(manifest({ engineMin: "3.0.0" }));

    expect(result.ok).toBe(true);
  });
});
