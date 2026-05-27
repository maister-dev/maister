import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendGuardMetric,
  evaluateGuards,
  readCostJsonlTotal,
} from "@/lib/flows/guards";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "guards-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("evaluateGuards", () => {
  it("cost cap not exceeded when costTokens below cap", () => {
    const metrics = evaluateGuards([{ cost: 1000 }], {
      durationMs: 0,
      stdout: "",
      costTokens: 500,
    });

    expect(metrics).toHaveLength(1);
    expect(metrics[0].capExceeded).toBe(false);
  });

  it("cost cap exceeded when costTokens above cap", () => {
    const metrics = evaluateGuards([{ cost: 1000 }], {
      durationMs: 0,
      stdout: "",
      costTokens: 1500,
    });

    expect(metrics[0].capExceeded).toBe(true);
  });

  it("time cap not exceeded when durationMs below time*1000", () => {
    const metrics = evaluateGuards([{ time: 30 }], {
      durationMs: 25_000,
      stdout: "",
    });

    expect(metrics[0].capExceeded).toBe(false);
  });

  it("time cap exceeded when durationMs above time*1000", () => {
    const metrics = evaluateGuards([{ time: 30 }], {
      durationMs: 35_000,
      stdout: "",
    });

    expect(metrics[0].capExceeded).toBe(true);
  });

  it("regex not matched is recorded but not a cap", () => {
    const metrics = evaluateGuards([{ regex: "ERROR" }], {
      durationMs: 0,
      stdout: "all good",
    });

    expect(metrics[0].regexMatched).toBe(false);
    expect(metrics[0].capExceeded).toBe(false);
  });

  it("regex matched is recorded", () => {
    const metrics = evaluateGuards([{ regex: "ERROR" }], {
      durationMs: 0,
      stdout: "something ERROR happened",
    });

    expect(metrics[0].regexMatched).toBe(true);
  });

  it("empty guards array returns no metrics", () => {
    expect(evaluateGuards([], { durationMs: 0, stdout: "" })).toEqual([]);
    expect(evaluateGuards(undefined, { durationMs: 0, stdout: "" })).toEqual(
      [],
    );
  });
});

describe("appendGuardMetric", () => {
  it("writes a parseable JSONL line under the expected path", async () => {
    await appendGuardMetric({
      runtimeRoot: workDir,
      projectSlug: "demo-app",
      runId: "run-1",
      stepId: "plan",
      kind: "pre",
      metrics: [
        {
          guard: { cost: 1000 },
          observed: { durationMs: 0, costTokens: 50 },
          capExceeded: false,
        },
      ],
    });

    const file = join(
      workDir,
      ".maister",
      "demo-app",
      "runs",
      "run-1",
      "guards.jsonl",
    );
    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n");

    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]);

    expect(obj.stepId).toBe("plan");
    expect(obj.kind).toBe("pre");
    expect(obj.guard).toEqual({ cost: 1000 });
    expect(obj.observed.costTokens).toBe(50);
  });
});

describe("readCostJsonlTotal", () => {
  it("sums cache_creation+input+output across multiple lines", async () => {
    const dir = join(workDir, ".maister", "demo", "runs", "r1");

    await mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        cache_creation_input_tokens: 100,
        input_tokens: 50,
        output_tokens: 25,
      }),
      JSON.stringify({ input_tokens: 10, output_tokens: 5 }),
      JSON.stringify({ cache_creation_input_tokens: 200 }),
    ];

    await writeFile(join(dir, "cost.jsonl"), lines.join("\n") + "\n", "utf8");

    const total = await readCostJsonlTotal(workDir, "demo", "r1");

    expect(total).toBe(100 + 50 + 25 + 10 + 5 + 200);
  });

  it("missing file returns 0", async () => {
    expect(await readCostJsonlTotal(workDir, "missing", "missing")).toBe(0);
  });

  it("malformed line is skipped, others summed", async () => {
    const dir = join(workDir, ".maister", "demo", "runs", "r2");

    await mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ input_tokens: 10 }),
      "not-json-broken",
      JSON.stringify({ output_tokens: 5 }),
    ];

    await writeFile(join(dir, "cost.jsonl"), lines.join("\n") + "\n", "utf8");

    expect(await readCostJsonlTotal(workDir, "demo", "r2")).toBe(15);
  });
});
