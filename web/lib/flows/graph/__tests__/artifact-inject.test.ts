import { describe, expect, it } from "vitest";

import {
  augmentPromptWithInlineTags,
  collectContentArtifactIds,
  inlineRequires,
  isInjectableArtifactId,
  scanContentRefs,
} from "@/lib/flows/graph/artifact-inject";

// ADR-120 (P2): pure helpers — delimiter-aware id collection + inline XML-tag
// auto-append. No I/O. This is the SAME `collectContentArtifactIds` the Phase-1
// load-time engine-floor gate imports (single source of truth).

describe("scanContentRefs — delimiter-aware {{ artifacts.<id>.content }} scan", () => {
  it("captures a simple ref", () => {
    expect(scanContentRefs("see {{ artifacts.plan.content }} below")).toEqual([
      "plan",
    ]);
  });

  it("captures a hyphenated id", () => {
    expect(scanContentRefs("{{ artifacts.plan-summary.content }}")).toEqual([
      "plan-summary",
    ]);
  });

  it("captures the guarded `?? default` form", () => {
    expect(scanContentRefs("{{ artifacts.plan.content ?? 'none' }}")).toEqual([
      "plan",
    ]);
  });

  it("does NOT match a bare-text mention outside {{ }}", () => {
    expect(scanContentRefs("the artifacts.plan.content field")).toEqual([]);
  });

  it("does NOT match a metadata accessor (.uri)", () => {
    expect(scanContentRefs("{{ artifacts.plan.uri }}")).toEqual([]);
  });

  it("captures multiple distinct refs in one template", () => {
    expect(
      scanContentRefs("{{ artifacts.a.content }} {{ artifacts.b.content }}"),
    ).toEqual(["a", "b"]);
  });

  it("returns [] for null/undefined/empty", () => {
    expect(scanContentRefs(null)).toEqual([]);
    expect(scanContentRefs(undefined)).toEqual([]);
    expect(scanContentRefs("")).toEqual([]);
  });
});

describe("collectContentArtifactIds — union over prompt/command/gate ∪ inline", () => {
  it("collects from action.prompt", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "{{ artifacts.plan.content }}" },
      }),
    ).toEqual(["plan"]);
  });

  it("collects from action.command (cli)", () => {
    expect(
      collectContentArtifactIds({
        type: "cli",
        action: { command: "echo {{ artifacts.diff.content }}" },
      }),
    ).toEqual(["diff"]);
  });

  // Codex finding: type-aware action scan — an unused passthrough field on the
  // wrong node type must NOT be collected (it is never rendered by the executor).

  it("does NOT collect a leftover action.command on an agent node (renders prompt only)", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "do it", command: "{{ artifacts.unused.content }}" },
      }),
    ).toEqual([]);
  });

  it("does NOT collect a leftover action.prompt on a cli node (renders command only)", () => {
    expect(
      collectContentArtifactIds({
        type: "cli",
        action: { command: "true", prompt: "{{ artifacts.unused.content }}" },
      }),
    ).toEqual([]);
  });

  it("collects from an ai_judgment gate prompt", () => {
    expect(
      collectContentArtifactIds({
        type: "judge",
        action: { prompt: "judge" },
        pre_finish: {
          gates: [
            {
              id: "g1",
              kind: "ai_judgment",
              prompt: "rate {{ artifacts.plan.content }}",
            },
          ],
        },
      }),
    ).toEqual(["plan"]);
  });

  // Codex finding #1: the scan must match the field each gate EXECUTOR renders,
  // not blanket-scan `prompt`. ai_judgment→prompt, skill_check/command_check→command.

  it("does NOT collect an ai_judgment gate `command` (ai_judgment renders prompt)", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "x" },
        pre_finish: {
          gates: [
            {
              id: "g1",
              kind: "ai_judgment",
              command: "{{ artifacts.plan.content }}",
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("collects a skill_check gate `command` (executor renders command, not prompt)", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "x" },
        pre_finish: {
          gates: [
            {
              id: "g1",
              kind: "skill_check",
              command: "run {{ artifacts.plan.content }}",
            },
          ],
        },
      }),
    ).toEqual(["plan"]);
  });

  it("does NOT collect a skill_check gate `prompt` (unused field — no false positive)", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "x" },
        pre_finish: {
          gates: [
            {
              id: "g1",
              kind: "skill_check",
              prompt: "{{ artifacts.plan.content }}",
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("collects a command_check gate `command` (rendered via runCliStep, like a cli node)", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "x" },
        pre_finish: {
          gates: [
            {
              id: "g1",
              kind: "command_check",
              command: "echo {{ artifacts.plan.content }}",
            },
          ],
        },
      }),
    ).toEqual(["plan"]);
  });

  it("does NOT collect a command_check gate `prompt` (unused field for command_check)", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "x" },
        pre_finish: {
          gates: [
            {
              id: "g1",
              kind: "command_check",
              prompt: "{{ artifacts.plan.content }}",
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("collects inline:true requires even with no template ref", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "no refs here" },
        input: { requires: [{ artifact: "plan", kind: "plan", inline: true }] },
      }),
    ).toEqual(["plan"]);
  });

  it("unions + dedupes a manual ref and an inline require for the same id", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "{{ artifacts.plan.content }}" },
        input: { requires: [{ artifact: "plan", kind: "plan", inline: true }] },
      }),
    ).toEqual(["plan"]);
  });

  it("ignores a non-inline requires entry and a bare-string requires", () => {
    expect(
      collectContentArtifactIds({
        type: "ai_coding",
        action: { prompt: "x" },
        input: {
          requires: ["steps.prev.output", { artifact: "plan", kind: "plan" }],
        },
      }),
    ).toEqual([]);
  });
});

describe("collectContentArtifactIds — includeGate filter (Codex #1)", () => {
  const node = {
    type: "ai_coding",
    action: { prompt: "{{ artifacts.a.content }}" },
    input: { requires: [{ artifact: "b", kind: "plan", inline: true }] },
    pre_finish: {
      gates: [
        {
          id: "g",
          kind: "command_check",
          command: "{{ artifacts.c.content }}",
        },
      ],
    },
  };

  it("includes gate refs by default (load-time floor gate — all gates considered)", () => {
    expect(collectContentArtifactIds(node)).toEqual(["a", "b", "c"]);
  });

  it("excludes a gate's refs when includeGate returns false (skip-aware runner set)", () => {
    // The runner excludes policy-skipped gates so a skipped gate's gone ref is
    // never resolved and can never fail the node.
    expect(
      collectContentArtifactIds(node, {
        includeGate: (g) => g.kind !== "command_check",
      }),
    ).toEqual(["a", "b"]);
  });

  it("action + inline refs are always collected regardless of includeGate", () => {
    expect(
      collectContentArtifactIds(node, { includeGate: () => false }),
    ).toEqual(["a", "b"]);
  });
});

describe("isInjectableArtifactId — slug grammar for body-injectable ids", () => {
  it("accepts slug ids (letters, digits, underscore, hyphen)", () => {
    expect(isInjectableArtifactId("plan")).toBe(true);
    expect(isInjectableArtifactId("plan-summary")).toBe(true);
    expect(isInjectableArtifactId("plan_v2")).toBe(true);
  });

  it("rejects ids with chars that break the XML attr / Mustache path / scan", () => {
    expect(isInjectableArtifactId("plan.summary")).toBe(false);
    expect(isInjectableArtifactId("ns:plan")).toBe(false);
    expect(isInjectableArtifactId('pl"an')).toBe(false);
    expect(isInjectableArtifactId("plan summary")).toBe(false);
    expect(isInjectableArtifactId("")).toBe(false);
  });
});

describe("inlineRequires — extract { artifact, kind } inline pairs", () => {
  it("returns only inline:true entries with their kind", () => {
    expect(
      inlineRequires({
        input: {
          requires: [
            { artifact: "plan", kind: "plan", inline: true },
            { artifact: "spec", kind: "generic_file" },
            "steps.prev.output",
          ],
        },
      }),
    ).toEqual([{ artifact: "plan", kind: "plan" }]);
  });
});

describe("augmentPromptWithInlineTags — XML-tag auto-append + dedup", () => {
  it("appends one XML block carrying a {{ }} tag (not resolved body)", () => {
    const r = augmentPromptWithInlineTags("base prompt", [
      { artifact: "plan", kind: "plan" },
    ]);

    expect(r.injectedIds).toEqual(["plan"]);
    expect(r.skippedIds).toEqual([]);
    expect(r.prompt).toBe(
      'base prompt\n<artifact id="plan" kind="plan">\n{{ artifacts.plan.content }}\n</artifact>',
    );
  });

  it("skips (WARN signal) an id already manually referenced — single injection", () => {
    const r = augmentPromptWithInlineTags(
      "use {{ artifacts.plan.content }} here",
      [{ artifact: "plan", kind: "plan" }],
    );

    expect(r.injectedIds).toEqual([]);
    expect(r.skippedIds).toEqual(["plan"]);
    expect(r.prompt).toBe("use {{ artifacts.plan.content }} here");
  });

  it("appends in deterministic order after the existing content", () => {
    const r = augmentPromptWithInlineTags("P\n\n[Run context: /x]", [
      { artifact: "a", kind: "diff" },
      { artifact: "b", kind: "log" },
    ]);

    expect(r.prompt).toBe(
      "P\n\n[Run context: /x]" +
        '\n<artifact id="a" kind="diff">\n{{ artifacts.a.content }}\n</artifact>' +
        '\n<artifact id="b" kind="log">\n{{ artifacts.b.content }}\n</artifact>',
    );
    expect(r.injectedIds).toEqual(["a", "b"]);
  });
});
