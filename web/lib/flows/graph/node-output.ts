import "server-only";

import type { KnowledgeAccessCapture } from "@/lib/company/types";
import type { FormSchema } from "@/lib/config.schema";
import type { NodeAttemptOutputContract } from "@/lib/db/schema";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { RunResultContract } from "@/lib/run-results/types";
import type { StepResult } from "../types";
import type { CompiledNode } from "./compile";
import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type { RuntimeObjectTransportResolver } from "@/lib/execution-host/runtime-objects";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { validateStructuredOutput } from "../output-schema";

import { markNodeFailed } from "./ledger";

import { resolveOutputResultSchemaWithIdentity } from "@/lib/config";
import { MaisterError } from "@/lib/errors";
import { readRuntimeObjectContent } from "@/lib/execution-host/runtime-objects";
import { MAISTER_ENGINE_VERSION } from "@/lib/flows/engine-version";
import { nodeOutputMaxBytes } from "@/lib/instance-config";
import {
  isResultProducerNode,
  usesStructuredKnowledgeContext,
} from "@/lib/run-results/contract";
import { validateParsedResultValue } from "@/lib/run-results/validate";
import { validateFindingsReferences } from "@/lib/run-results/findings-references";

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

export type NodeOutputTransport = "sentinel" | "file" | "engine_vars";

// ADR-162 (C-1): the ONE map from node type to structured-output transport.
// The seam, the load-time refusals, and the shipped authoring grammar all
// derive from it. Transport follows the node's EXECUTION MECHANISM and is never
// author-declared; `null` means the node type has no structured-output channel
// (human/form take their vars from the HITL input artifact, and declaring
// `output.result` on them is refused at manifest load).
export const NODE_OUTPUT_TRANSPORT: Record<
  CompiledNode["nodeType"],
  NodeOutputTransport | null
> = {
  ai_coding: "sentinel",
  judge: "sentinel",
  orchestrator: "sentinel",
  cli: "file",
  check: "file",
  consensus: "engine_vars",
  human: null,
  form: null,
  wait: null,
  publish: null,
};

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

export async function readSealedCliOutput(
  input: Readonly<{
    db: ExecutionDb;
    runId: string;
    objectId: string;
    sha256: string;
    signal?: AbortSignal;
    transportForHost?: RuntimeObjectTransportResolver;
  }>,
): Promise<RawNodeOutputPayload> {
  const { object, content } = await readRuntimeObjectContent({
    db: input.db,
    runId: input.runId,
    objectId: input.objectId,
    signal: input.signal,
    transportForHost: input.transportForHost,
  });
  if (
    object.kind !== "diagnostic" ||
    object.logicalName !== "workload-result.json" ||
    object.mimeType !== "application/json" ||
    object.sha256 !== input.sha256
  )
    throw new MaisterError(
      "ACP_PROTOCOL",
      "The sealed CLI result differs from its workload receipt",
      {
        details: { reason: "runtime_object_integrity_mismatch" },
      },
    );

  return parsePayload(
    Buffer.from(content.bytes).toString("utf8"),
    nodeOutputMaxBytes(),
    "sealed MAISTER_OUTPUT_FILE",
  );
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

const ABSENT_REASON: Record<NodeOutputTransport, string> = {
  sentinel:
    "structured output required but absent: no maister:output block in the captured output",
  file: "structured output required but absent: MAISTER_OUTPUT_FILE was not written",
  engine_vars:
    "structured output required but absent: the node produced no engine vars",
};

// ADR-162 (C-2): the `engine_vars` transport. The value IS the engine-produced
// `result.vars` object; absent means zero own keys. The byte cap applies to the
// serialized form so an engine-side runaway is bounded exactly like the other
// two transports.
export function readEngineVars(
  vars: Record<string, unknown>,
  maxBytes: number,
): RawNodeOutputPayload {
  if (Object.keys(vars).length === 0) return { kind: "absent" };

  let serialized: string;

  try {
    serialized = JSON.stringify(vars);
  } catch (err) {
    return {
      kind: "invalid",
      reason: `engine vars are not serializable: ${(err as Error).message}`,
    };
  }

  const bytes = Buffer.byteLength(serialized, "utf8");

  if (bytes > maxBytes) {
    return {
      kind: "invalid",
      reason: `engine vars are ${bytes} bytes — exceeds MAISTER_NODE_OUTPUT_MAX_BYTES (${maxBytes})`,
    };
  }

  return { kind: "value", value: vars };
}

export type ValidateNodeStructuredOutputArgs = {
  node: Pick<CompiledNode, "id" | "nodeType" | "output">;
  result: Pick<StepResult, "stdout" | "vars" | "originalOutput">;
  attempt: number;
  nodeAttemptId: string;
  runId: string;
  projectSlug: string;
  runtimeRoot: string;
  flowInstallPath: string;
  // ADR-165: the run's launch-time public-result contract, or null. When this
  // node is one of its producers the seam validates against the SNAPSHOT rather
  // than re-reading the pinned revision — re-pointing the flow mid-run must not
  // change which schema an in-flight attempt is held to.
  resultContract?: RunResultContract | null;
  knowledgeAccess?: KnowledgeAccessCapture | null;
  db: Db;
};

export type StructuredOutputOutcome =
  // ADR-162 (C-9): `contract` is set once the declared schema has been resolved
  // — the caller persists it on the same UPDATE that closes the attempt. Absent
  // when the node declared no `output.result`, or when the seam failed before
  // the schema was read (no identity exists then).
  // ADR-165: `value` is the PURE validated payload — `result.vars` is a merged
  // bag (engine vars + this value), so a caller that must persist the value
  // alone cannot recover it from there. Present only when a payload existed.
  | {
      ok: true;
      contract?: NodeAttemptOutputContract;
      value?: Record<string, unknown>;
      valueBytes?: number;
    }
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
  const transport = NODE_OUTPUT_TRANSPORT[args.node.nodeType];

  // Defensive skip: a human/form declaration is refused at manifest load
  // (ADR-162 C-10), so reaching here means a pre-refusal stored manifest.
  if (!decl || transport === null) {
    return { ok: true };
  }

  log.debug(
    { nodeId: args.node.id, nodeType: args.node.nodeType, transport },
    "structured output: transport selected",
  );

  const maxBytes = nodeOutputMaxBytes();
  let payload: RawNodeOutputPayload;

  if (transport === "sentinel") {
    payload =
      args.result.originalOutput ??
      extractSentinelBlock(args.result.stdout, maxBytes);
  } else if (transport === "engine_vars") {
    payload = readEngineVars(args.result.vars, maxBytes);
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

    payload =
      args.result.originalOutput ??
      (await readCliOutputFile(filePath, maxBytes));
  }

  if (payload.kind === "absent") {
    if (decl.required ?? false) {
      return failAttempt(args, ABSENT_REASON[transport]);
    }

    log.debug(
      { nodeId: args.node.id, attempt: args.attempt, transport },
      "structured output absent (optional) — vars unchanged",
    );

    return { ok: true };
  }

  if (payload.kind === "invalid") {
    return failAttempt(args, payload.reason);
  }

  // ADR-165: a PRODUCER of the run's public result is judged by the launch
  // snapshot, whose identity the run already committed. Every other node keeps
  // the ADR-162 lazy resolve from the pinned install path. The two agree by
  // construction — load-time R8 forces a producer's `output.result.schema` to
  // equal the export's — so this is about WHICH copy is authoritative, not about
  // two different schemas.
  const isProducer = isResultProducerNode(
    args.resultContract ?? null,
    args.node.id,
  );
  let resolved: { schema: FormSchema; sha256: string };

  if (isProducer && args.resultContract) {
    resolved = {
      schema: args.resultContract.schema,
      sha256: args.resultContract.sha256,
    };
  } else {
    try {
      resolved = await resolveOutputResultSchemaWithIdentity(
        args.flowInstallPath,
        decl.schema,
      );
    } catch (err) {
      return failAttempt(
        args,
        `output.result schema unresolvable: ${(err as Error).message}`,
      );
    }
  }

  const contract: NodeAttemptOutputContract = {
    schemaRef: decl.schema,
    schemaVersion: resolved.schema.schemaVersion,
    sha256: resolved.sha256,
    transport,
    engineVersion: MAISTER_ENGINE_VERSION,
  };

  log.debug(
    {
      nodeId: args.node.id,
      attempt: args.attempt,
      schemaRef: contract.schemaRef,
      sha256: contract.sha256.slice(0, 12),
      transport,
    },
    "structured output: contract resolved",
  );

  const frozen = args.resultContract;
  const verdict =
    isProducer && frozen?.kind === "flow_export" && frozen.nativeContract
      ? validateParsedResultValue({
          value: payload.value,
          schema: resolved.schema,
          nativeContract: frozen.nativeContract,
          maxBytes,
          label: "public result",
        })
      : validateStructuredOutput(payload.value, resolved.schema);

  if (!verdict.ok) {
    return failAttempt(
      args,
      `structured output schema mismatch: ${verdict.message}`,
      contract,
    );
  }

  const value = payload.value as Record<string, unknown>;

  if (isProducer && frozen && usesStructuredKnowledgeContext(args)) {
    const references = await args.db.transaction((tx: SqlTransaction) =>
      validateFindingsReferences(
        tx,
        args.runId,
        frozen,
        {
          kind: "valid",
          value,
          valueBytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
        },
        args.nodeAttemptId,
      ),
    );

    if (references.kind === "invalid")
      return failAttempt(args, references.message, contract);
  }

  // ADR-162 (C-2): the engine produced these vars — validation is all the seam
  // does. Folding a validated copy back over them would be a no-op at best and
  // a silent overwrite of engine state at worst.
  if (transport !== "engine_vars") {
    args.result.vars = { ...args.result.vars, ...value };
  }
  log.info(
    {
      nodeId: args.node.id,
      attempt: args.attempt,
      transport,
      keys: Object.keys(value),
    },
    "structured output captured",
  );

  return {
    ok: true,
    contract,
    value,
    valueBytes: Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"),
  };
}

async function failAttempt(
  args: ValidateNodeStructuredOutputArgs,
  reason: string,
  contract?: NodeAttemptOutputContract,
): Promise<StructuredOutputOutcome> {
  const base = args.result.stdout;
  const stdout = `${base}${base.length > 0 && !base.endsWith("\n") ? "\n" : ""}[structured output] ${reason}`;

  await markNodeFailed(
    args.nodeAttemptId,
    {
      errorCode: "CONFIG",
      stdout,
      ...(contract ? { outputContract: contract } : {}),
    },
    args.db,
  );

  return { ok: false, reason };
}
