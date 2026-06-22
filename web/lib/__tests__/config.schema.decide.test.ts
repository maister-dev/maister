import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { decideSchema, nodeOutputSchema } from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";

describe("decideSchema (M38, ADR-103)", () => {
  it("accepts from: output.<dotpath> incl. nested", () => {
    expect(decideSchema.safeParse({ from: "output.outcome" }).success).toBe(true);
    expect(decideSchema.safeParse({ from: "output.triage.outcome" }).success).toBe(true);
    expect(decideSchema.safeParse({ from: "output.a.b.c" }).success).toBe(true);
  });

  it("accepts from: verdict with cases + exactly one default", () => {
    const r = decideSchema.safeParse({
      from: "verdict",
      cases: [
        { when: "confidence >= 0.8", target: "approve" },
        { default: true, target: "review" },
      ],
    });

    expect(r.success).toBe(true);
  });

  it("rejects two defaults (from: verdict)", () => {
    const r = decideSchema.safeParse({
      from: "verdict",
      cases: [
        { default: true, target: "a" },
        { default: true, target: "b" },
      ],
    });

    expect(r.success).toBe(false);
  });

  it("rejects from: verdict with zero defaults", () => {
    const r = decideSchema.safeParse({
      from: "verdict",
      cases: [{ when: "confidence >= 0.8", target: "approve" }],
    });

    expect(r.success).toBe(false);
  });

  it("rejects cases on a from: output decide", () => {
    const r = decideSchema.safeParse({
      from: "output.x",
      cases: [{ default: true, target: "a" }],
    });

    expect(r.success).toBe(false);
  });

  it("rejects a malformed from dot-path", () => {
    for (const bad of ["output", "output.", "output.1bad", "out.x", "verdictx", "output..x"]) {
      expect(decideSchema.safeParse({ from: bad }).success, bad).toBe(false);
    }
  });

  it("rejects unknown keys (strict)", () => {
    expect(decideSchema.safeParse({ from: "verdict", extra: 1 }).success).toBe(false);
    expect(
      decideSchema.safeParse({
        from: "verdict",
        cases: [{ default: true, target: "a", extra: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("output.result.on_mismatch (M38, ADR-103)", () => {
  it("accepts the literal retry and any other string", () => {
    expect(
      nodeOutputSchema.safeParse({ result: { schema: "./s.json", on_mismatch: "retry" } }).success,
    ).toBe(true);
    expect(
      nodeOutputSchema.safeParse({ result: { schema: "./s.json", on_mismatch: "fix" } }).success,
    ).toBe(true);
  });

  it("keeps output.result strict (rejects unknown keys)", () => {
    expect(
      nodeOutputSchema.safeParse({ result: { schema: "./s.json", bogus: 1 } }).success,
    ).toBe(false);
  });

  it("accepts output.result without on_mismatch (back-compat)", () => {
    expect(nodeOutputSchema.safeParse({ result: { schema: "./s.json" } }).success).toBe(true);
  });
});

describe("engine gate — decide/on_mismatch require engine_min >= 1.7.0", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "decide-engine-gate-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function load(manifest: unknown): Promise<{ ok: boolean; code?: string }> {
    const path = join(workDir, "flow.yaml");

    await writeFile(path, stringifyYaml(manifest), "utf8");
    try {
      await loadFlowManifest(path);

      return { ok: true };
    } catch (err) {
      return { ok: false, code: isMaisterError(err) ? err.code : "UNKNOWN" };
    }
  }

  function decideManifest(engineMin: string): unknown {
    return {
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: engineMin },
      nodes: [
        {
          id: "a",
          type: "ai_coding",
          action: { prompt: "x" },
          output: { result: { schema: "./s.json" } },
          decide: { from: "output.outcome" },
          transitions: { bug: "done", feature: "done" },
        },
      ],
    };
  }

  function onMismatchManifest(engineMin: string): unknown {
    return {
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: engineMin },
      nodes: [
        {
          id: "a",
          type: "ai_coding",
          action: { prompt: "x" },
          output: { result: { schema: "./s.json", on_mismatch: "retry" } },
          rework: { allowedTargets: ["a"], workspacePolicies: ["keep"], maxLoops: 2 },
          transitions: { success: "done" },
        },
      ],
    };
  }

  it("rejects decide with engine_min 1.6.0 (CONFIG)", async () => {
    const r = await load(decideManifest("1.6.0"));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("accepts decide with engine_min 1.7.0", async () => {
    expect((await load(decideManifest("1.7.0"))).ok).toBe(true);
  });

  it("rejects on_mismatch with engine_min 1.6.0 (CONFIG)", async () => {
    const r = await load(onMismatchManifest("1.6.0"));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("accepts on_mismatch with engine_min 1.7.0", async () => {
    expect((await load(onMismatchManifest("1.7.0"))).ok).toBe(true);
  });

  it("a flow declaring neither stays valid at its old floor (1.2.0)", async () => {
    const r = await load({
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "a",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    });

    expect(r.ok).toBe(true);
  });
});
