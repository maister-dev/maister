import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { isMaisterError } from "@/lib/errors";

// ADR-120 (P2): two body-injection surfaces gated at the 2.2.0 engine floor —
// `input.requires[].inline: true` (grammar) AND any `{{ artifacts.<id>.content }}`
// template reference (load-time scan). Plus the D12 node-type restriction on
// `inline:true`. All refusals surface as MaisterError("CONFIG") via loadFlowManifest.

describe("ADR-120 — artifact body injection: schema + engine floor + node-type", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "artifact-inline-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function load(
    manifest: unknown,
  ): Promise<{ ok: boolean; code?: string }> {
    const path = join(workDir, "flow.yaml");

    await writeFile(path, stringifyYaml(manifest), "utf8");
    try {
      await loadFlowManifest(path);

      return { ok: true };
    } catch (err) {
      return { ok: false, code: isMaisterError(err) ? err.code : "UNKNOWN" };
    }
  }

  // A two-node graph: `produce` emits artifact `plan`; `consume` references it.
  // `consumerExtra` injects the surface under test onto the consume node.
  function manifest(opts: {
    engineMin: string;
    consumerType?:
      | "ai_coding"
      | "judge"
      | "orchestrator"
      | "cli"
      | "check"
      | "human"
      | "form";
    requires?: unknown[];
    consumePrompt?: string;
    consumeGatePrompt?: string;
  }): unknown {
    const consumerType = opts.consumerType ?? "ai_coding";
    const consume: Record<string, unknown> = {
      id: "consume",
      type: consumerType,
      transitions: { success: "done" },
    };

    if (opts.requires) consume.input = { requires: opts.requires };

    if (consumerType === "cli" || consumerType === "check") {
      consume.action = { command: opts.consumePrompt ?? "true" };
    } else if (consumerType === "form") {
      consume.settings = { form_schema: "./form.json" };
    } else if (consumerType === "human") {
      // no action
    } else {
      consume.action = { prompt: opts.consumePrompt ?? "use it" };
    }

    if (opts.consumeGatePrompt) {
      consume.pre_finish = {
        gates: [
          { id: "g1", kind: "ai_judgment", prompt: opts.consumeGatePrompt },
        ],
      };
    }

    return {
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: opts.engineMin },
      nodes: [
        {
          id: "produce",
          type: "ai_coding",
          action: { prompt: "make it" },
          output: { produces: [{ id: "plan", kind: "plan" }] },
          transitions: { success: "consume" },
        },
        consume,
      ],
    };
  }

  const inlineReq = [{ artifact: "plan", kind: "plan", inline: true }];

  // --- schema: inline typing ---

  it("parses { artifact, kind, inline: true } at engine 2.2.0", async () => {
    expect(
      (await load(manifest({ engineMin: "2.2.0", requires: inlineReq }))).ok,
    ).toBe(true);
  });

  it("rejects a non-boolean inline (zod → CONFIG)", async () => {
    const r = await load(
      manifest({
        engineMin: "2.2.0",
        requires: [{ artifact: "plan", kind: "plan", inline: "yes" }],
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("a bare-string requires entry stays valid at the 1.2.0 floor (no inline expressible)", async () => {
    expect(
      (await load(manifest({ engineMin: "1.2.0", requires: ["plan"] }))).ok,
    ).toBe(true);
  });

  // --- D12: node-type restriction ---

  it.each(["cli", "check", "human", "form"] as const)(
    "rejects inline:true on a %s node (D12 → CONFIG)",
    async (consumerType) => {
      const r = await load(
        manifest({ engineMin: "2.2.0", consumerType, requires: inlineReq }),
      );

      expect(r.ok).toBe(false);
      expect(r.code).toBe("CONFIG");
    },
  );

  it.each(["ai_coding", "judge", "orchestrator"] as const)(
    "allows inline:true on a %s node (D12 OK)",
    async (consumerType) => {
      expect(
        (
          await load(
            manifest({ engineMin: "2.2.0", consumerType, requires: inlineReq }),
          )
        ).ok,
      ).toBe(true);
    },
  );

  // --- floor: inline:true surface ---

  it("rejects inline:true at engine 2.1.0 (CONFIG)", async () => {
    const r = await load(manifest({ engineMin: "2.1.0", requires: inlineReq }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("accepts inline:true at engine 2.2.0", async () => {
    expect(
      (await load(manifest({ engineMin: "2.2.0", requires: inlineReq }))).ok,
    ).toBe(true);
  });

  // --- floor: {{ artifacts.X.content }} scan surface ---

  it("rejects a {{ content }} ref in action.prompt at engine 2.1.0 (CONFIG)", async () => {
    const r = await load(
      manifest({
        engineMin: "2.1.0",
        consumePrompt: "use {{ artifacts.plan.content }}",
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("accepts a {{ content }} ref in action.prompt at engine 2.2.0", async () => {
    expect(
      (
        await load(
          manifest({
            engineMin: "2.2.0",
            consumePrompt: "use {{ artifacts.plan.content }}",
          }),
        )
      ).ok,
    ).toBe(true);
  });

  it("rejects a {{ content }} ref in an ai_judgment gate prompt at engine 2.1.0 (CONFIG)", async () => {
    const r = await load(
      manifest({
        engineMin: "2.1.0",
        consumeGatePrompt: "rate {{ artifacts.plan.content }}",
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("does NOT gate a bare-text artifacts.x.content mention outside {{ }} (delimiter-aware)", async () => {
    expect(
      (
        await load(
          manifest({
            engineMin: "2.1.0",
            consumePrompt: "the artifacts.plan.content field",
          }),
        )
      ).ok,
    ).toBe(true);
  });

  // --- inline artifact-id grammar (Codex finding #3) ---

  it("rejects inline:true with a non-slug (dotted) artifact id (CONFIG)", async () => {
    const r = await load({
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: "2.2.0" },
      nodes: [
        {
          id: "produce",
          type: "ai_coding",
          action: { prompt: "make it" },
          output: { produces: [{ id: "plan.bad", kind: "plan" }] },
          transitions: { success: "consume" },
        },
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "use it" },
          input: {
            requires: [{ artifact: "plan.bad", kind: "plan", inline: true }],
          },
          transitions: { success: "done" },
        },
      ],
    });

    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFIG");
  });

  it("accepts inline:true with a hyphenated slug artifact id", async () => {
    const r = await load({
      schemaVersion: 1,
      name: "f",
      compat: { engine_min: "2.2.0" },
      nodes: [
        {
          id: "produce",
          type: "ai_coding",
          action: { prompt: "make it" },
          output: { produces: [{ id: "plan-summary", kind: "plan" }] },
          transitions: { success: "consume" },
        },
        {
          id: "consume",
          type: "ai_coding",
          action: { prompt: "use it" },
          input: {
            requires: [
              { artifact: "plan-summary", kind: "plan", inline: true },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    expect(r.ok).toBe(true);
  });

  // --- SET/CLEAR symmetry (both surfaces) ---

  it("CLEAR symmetry: removing inline:true makes the manifest valid again at 1.2.0", async () => {
    expect(
      (
        await load(
          manifest({
            engineMin: "1.2.0",
            requires: [{ artifact: "plan", kind: "plan" }],
          }),
        )
      ).ok,
    ).toBe(true);
  });

  it("CLEAR symmetry: removing the {{ content }} ref makes the manifest valid again at 1.2.0", async () => {
    expect(
      (
        await load(
          manifest({ engineMin: "1.2.0", consumePrompt: "no refs here" }),
        )
      ).ok,
    ).toBe(true);
  });
});
