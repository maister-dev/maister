import "server-only";

import type { FormSchema } from "@/lib/config.schema";
import type { StepResult } from "../types";
import type { CompiledNode } from "./compile";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { validateStructuredOutput } from "../output-schema";

import { markNodeFailed } from "./ledger";

import { resolveOutputResultSchema } from "@/lib/config";
import { MaisterError } from "@/lib/errors";
import { nodeOutputMaxBytes } from "@/lib/instance-config";

// M26 P1 (ADR-063): structured node output — transport extraction + the
// post-action validate seam. Frozen SSOT:
// .ai-factory/specs/feature-m26-structured-output-run-context.md.

const log = pino({
  name: "flow-node-output",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants (matches ledger.ts).
type Db = any;

export type RawNodeOutputPayload =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "value"; value: unknown };

const SENTINEL_OPEN_RE = /^```json maister:output[ \t]*\r?$/;
const FENCE_CLOSE_RE = /^```[ \t]*\r?$/;

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parsePayload(
  raw: string,
  maxBytes: number,
  label: string,
): RawNodeOutputPayload {
  const bytes = Buffer.byteLength(raw, "utf8");

  if (bytes > maxBytes) {
    return {
      kind: "invalid",
      reason: `${label} is ${bytes} bytes — exceeds MAISTER_NODE_OUTPUT_MAX_BYTES (${maxBytes})`,
    };
  }

  const text = stripBom(raw).trim();

  if (text.length === 0) {
    return { kind: "invalid", reason: `${label} is empty` };
  }

  try {
    return { kind: "value", value: JSON.parse(text) as unknown };
  } catch (err) {
    return {
      kind: "invalid",
      reason: `${label} is not valid JSON: ${(err as Error).message}`,
    };
  }
}

// Last PROPERLY-FENCED ```json maister:output block in the (1 MiB-capped)
// stdout capture. An unterminated block — including one whose closing fence
// was pushed past the capture cap — is not a block (spec: treated as absent).
export function extractSentinelBlock(
  stdout: string,
  maxBytes: number,
): RawNodeOutputPayload {
  const lines = stdout.split("\n");
  let last: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (!SENTINEL_OPEN_RE.test(lines[i])) {
      i += 1;
      continue;
    }

    let close = -1;

    for (let j = i + 1; j < lines.length; j += 1) {
      if (FENCE_CLOSE_RE.test(lines[j])) {
        close = j;
        break;
      }
    }

    // Unterminated: no later line can close it, so scanning is done.
    if (close === -1) break;

    last = lines.slice(i + 1, close).join("\n");
    i = close + 1;
  }

  if (last === null) return { kind: "absent" };

  return parsePayload(last, maxBytes, "maister:output block");
}

// node.id comes from the manifest, so it must satisfy the filename-segment
// invariant before it is embedded in a run-dir path — a separator would let a
// manifest escape the run directory (mirrors the resolveOutputResultSchema
// escape-guard).
const NODE_ID_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

// Per-attempt cli/check output transport file. Single source of truth for the
// path: runner-cli injects it as MAISTER_OUTPUT_FILE, the seam reads it back.
export function cliOutputFilePath(args: {
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  nodeId: string;
  attempt: number;
}): string {
  if (!NODE_ID_SEGMENT_RE.test(args.nodeId)) {
    throw new MaisterError(
      "CONFIG",
      `node id "${args.nodeId}" is not a valid filename segment — MAISTER_OUTPUT_FILE path would escape the run directory`,
    );
  }

  return path.join(
    args.runtimeRoot,
    ".maister",
    args.projectSlug,
    "runs",
    args.runId,
    `output-${args.nodeId}-${args.attempt}.json`,
  );
}

export async function readCliOutputFile(
  filePath: string,
  maxBytes: number,
): Promise<RawNodeOutputPayload> {
  let st: Awaited<ReturnType<typeof stat>>;

  try {
    st = await stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };

    return {
      kind: "invalid",
      reason: `cannot stat MAISTER_OUTPUT_FILE: ${(err as Error).message}`,
    };
  }

  if (!st.isFile()) {
    return {
      kind: "invalid",
      reason: "MAISTER_OUTPUT_FILE path is not a regular file",
    };
  }

  if (st.size > maxBytes) {
    return {
      kind: "invalid",
      reason: `MAISTER_OUTPUT_FILE is ${st.size} bytes — exceeds MAISTER_NODE_OUTPUT_MAX_BYTES (${maxBytes})`,
    };
  }

  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      kind: "invalid",
      reason: `cannot read MAISTER_OUTPUT_FILE: ${(err as Error).message}`,
    };
  }

  return parsePayload(raw, maxBytes, "MAISTER_OUTPUT_FILE");
}

export type ValidateNodeStructuredOutputArgs = {
  node: Pick<CompiledNode, "id" | "nodeType" | "output">;
  result: Pick<StepResult, "stdout" | "vars">;
  attempt: number;
  nodeAttemptId: string;
  runId: string;
  projectSlug: string;
  runtimeRoot: string;
  flowInstallPath: string;
  db: Db;
};

export type StructuredOutputOutcome =
  | { ok: true }
  | { ok: false; reason: string };

// The post-action validate seam (spec §Transport & validation, D-B2/D-B4).
// Runs after the node action succeeded and BEFORE pre_finish gates. No-op for
// nodes without `output.result` and for human/form nodes (their vars come from
// the HITL input artifact). On a valid payload MUTATES result.vars in place —
// the existing single markNodeSucceeded call persists it. On failure marks the
// attempt Failed with CONFIG (spec-strict: `required` excuses ABSENCE only; a
// present-but-broken payload always fails).
export async function validateNodeStructuredOutput(
  args: ValidateNodeStructuredOutputArgs,
): Promise<StructuredOutputOutcome> {
  const decl = args.node.output?.result;

  if (
    !decl ||
    args.node.nodeType === "human" ||
    args.node.nodeType === "form"
  ) {
    return { ok: true };
  }

  const transport =
    args.node.nodeType === "ai_coding" || args.node.nodeType === "judge"
      ? "sentinel"
      : "file";

  log.debug(
    { nodeId: args.node.id, nodeType: args.node.nodeType, transport },
    "structured output: extracting",
  );

  const maxBytes = nodeOutputMaxBytes();
  let payload: RawNodeOutputPayload;

  if (transport === "sentinel") {
    payload = extractSentinelBlock(args.result.stdout, maxBytes);
  } else {
    let filePath: string;

    try {
      filePath = cliOutputFilePath({
        runtimeRoot: args.runtimeRoot,
        projectSlug: args.projectSlug,
        runId: args.runId,
        nodeId: args.node.id,
        attempt: args.attempt,
      });
    } catch (err) {
      return failAttempt(args, (err as Error).message);
    }

    payload = await readCliOutputFile(filePath, maxBytes);
  }

  if (payload.kind === "absent") {
    if (decl.required ?? false) {
      return failAttempt(
        args,
        transport === "sentinel"
          ? "structured output required but absent: no maister:output block in the captured output"
          : "structured output required but absent: MAISTER_OUTPUT_FILE was not written",
      );
    }

    log.debug(
      { nodeId: args.node.id, attempt: args.attempt },
      "structured output absent (optional) — vars unchanged",
    );

    return { ok: true };
  }

  if (payload.kind === "invalid") {
    return failAttempt(args, payload.reason);
  }

  let schema: FormSchema;

  try {
    schema = await resolveOutputResultSchema(args.flowInstallPath, decl.schema);
  } catch (err) {
    return failAttempt(
      args,
      `output.result schema unresolvable: ${(err as Error).message}`,
    );
  }

  const verdict = validateStructuredOutput(payload.value, schema);

  if (!verdict.ok) {
    return failAttempt(
      args,
      `structured output schema mismatch: ${verdict.message}`,
    );
  }

  const value = payload.value as Record<string, unknown>;

  args.result.vars = { ...args.result.vars, ...value };
  log.info(
    { nodeId: args.node.id, attempt: args.attempt, keys: Object.keys(value) },
    "structured output captured",
  );

  return { ok: true };
}

async function failAttempt(
  args: ValidateNodeStructuredOutputArgs,
  reason: string,
): Promise<StructuredOutputOutcome> {
  const base = args.result.stdout;
  const stdout = `${base}${base.length > 0 && !base.endsWith("\n") ? "\n" : ""}[structured output] ${reason}`;

  await markNodeFailed(
    args.nodeAttemptId,
    { errorCode: "CONFIG", stdout },
    args.db,
  );

  return { ok: false, reason };
}
