import "server-only";

import type { GuardKind, GuardMetric } from "./types";

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

const log = pino({
  name: "flow-guards",
  level: process.env.LOG_LEVEL ?? "info",
});

export type GuardConfig = {
  cost?: number;
  time?: number;
  regex?: string;
};

export type Observed = {
  durationMs: number;
  stdout: string;
  costTokens?: number;
};

export function evaluateGuards(
  guards: GuardConfig[] | undefined,
  observed: Observed,
): GuardMetric[] {
  if (!guards || guards.length === 0) return [];

  const out: GuardMetric[] = [];

  for (const g of guards) {
    const metric: GuardMetric = {
      guard: { cost: g.cost, time: g.time, regex: g.regex },
      observed: {
        durationMs: observed.durationMs,
        costTokens: observed.costTokens,
      },
      capExceeded: false,
    };

    if (g.cost !== undefined && observed.costTokens !== undefined) {
      if (observed.costTokens > g.cost) {
        metric.capExceeded = true;
        log.warn(
          {
            guard: { cost: g.cost },
            observed: { costTokens: observed.costTokens },
          },
          "guard cost cap exceeded",
        );
      }
    }

    if (g.time !== undefined) {
      const timeMs = g.time * 1000;

      if (observed.durationMs > timeMs) {
        metric.capExceeded = true;
        log.warn(
          {
            guard: { timeSec: g.time },
            observed: { durationMs: observed.durationMs },
          },
          "guard time cap exceeded",
        );
      }
    }

    if (g.regex !== undefined) {
      try {
        const matched = new RegExp(g.regex).test(observed.stdout);

        metric.regexMatched = matched;
        metric.observed.regexMatched = matched;
      } catch (err) {
        log.warn(
          { regex: g.regex, err: (err as Error).message },
          "invalid guard regex",
        );
        metric.regexMatched = false;
        metric.observed.regexMatched = false;
      }
    }

    out.push(metric);
  }

  return out;
}

export type AppendGuardMetricArgs = {
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  stepId: string;
  kind: GuardKind;
  metrics: GuardMetric[];
};

export async function appendGuardMetric(
  args: AppendGuardMetricArgs,
): Promise<void> {
  if (args.metrics.length === 0) return;

  const dir = path.join(
    args.runtimeRoot,
    ".maister",
    args.projectSlug,
    "runs",
    args.runId,
  );
  const file = path.join(dir, "guards.jsonl");

  try {
    await mkdir(dir, { recursive: true });

    const lines = args.metrics
      .map((m) =>
        JSON.stringify({
          ts: new Date().toISOString(),
          stepId: args.stepId,
          kind: args.kind,
          ...m,
        }),
      )
      .join("\n");

    await appendFile(file, lines + "\n", "utf8");

    log.debug(
      {
        file,
        stepId: args.stepId,
        kind: args.kind,
        count: args.metrics.length,
      },
      "guard metric appended",
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message, file },
      "appendGuardMetric failed (non-fatal)",
    );
  }
}

export async function readCostJsonlTotal(
  runtimeRoot: string,
  projectSlug: string,
  runId: string,
): Promise<number> {
  const file = path.join(
    runtimeRoot,
    ".maister",
    projectSlug,
    "runs",
    runId,
    "cost.jsonl",
  );

  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "ENOENT") return 0;
    log.warn({ err: (err as Error).message, file }, "cost.jsonl read failed");

    return 0;
  }

  let total = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    let obj: Record<string, unknown>;

    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      log.debug({ file, line: trimmed.slice(0, 80) }, "malformed cost line");
      continue;
    }

    const fields = [
      "cache_creation_input_tokens",
      "input_tokens",
      "output_tokens",
    ];

    for (const f of fields) {
      const v = obj[f];

      if (typeof v === "number") total += v;
    }
  }

  return total;
}
