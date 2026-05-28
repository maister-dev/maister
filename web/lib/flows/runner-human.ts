import "server-only";

import type { FlowContext, StepResult } from "./types";

import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { renderStrict } from "./templating";

import { atomicWriteJson } from "@/lib/atomic";
import { validateFormSchemaVersion } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

const FORM_SCHEMA_VERSION = 1;

export type HumanStepLike = {
  id: string;
  type: "human";
  form_schema: string;
  on_reject?: {
    goto_step: string;
    comments_var?: string;
  };
};

export type RunHumanStepCtx = {
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  stepId: string;
  flowInstallPath: string;
  context: FlowContext;
  promptTemplate?: string;
  db?: unknown;
};

async function resolveSchemaPath(
  flowInstallPath: string,
  formSchema: string,
): Promise<string> {
  const joined = path.resolve(flowInstallPath, formSchema);

  if (!joined.startsWith(path.resolve(flowInstallPath) + path.sep)) {
    throw new MaisterError(
      "CONFIG",
      `form_schema path escapes flow install dir: ${formSchema}`,
    );
  }

  try {
    return await realpath(joined);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `form_schema file not found: ${joined} (${(err as Error).message})`,
      { cause: err as Error },
    );
  }
}

export async function runHumanStep(
  step: HumanStepLike,
  ctx: RunHumanStepCtx,
): Promise<StepResult & { needsInput: true }> {
  const startedAt = Date.now();
  const resolvedPath = await resolveSchemaPath(
    ctx.flowInstallPath,
    step.form_schema,
  );

  let raw: string;

  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `cannot read form_schema ${resolvedPath}: ${(err as Error).message}`,
      { cause: err as Error },
    );
  }

  let schema: unknown;

  try {
    schema = JSON.parse(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `form_schema is not valid JSON (${resolvedPath}): ${(err as Error).message}`,
      { cause: err as Error },
    );
  }

  validateFormSchemaVersion(schema, FORM_SCHEMA_VERSION);

  const promptText = ctx.promptTemplate
    ? renderStrict(
        ctx.promptTemplate,
        ctx.context as unknown as Record<string, unknown>,
        { traceLog: log },
      )
    : `Awaiting human input for step "${step.id}"`;

  const needsInputPath = path.join(
    ctx.runtimeRoot,
    ".maister",
    ctx.projectSlug,
    "runs",
    ctx.runId,
    "needs-input.json",
  );

  const body = {
    stepId: step.id,
    schemaVersion: FORM_SCHEMA_VERSION,
    schema,
    prompt: promptText,
    on_reject: step.on_reject ?? null,
    requestedAt: new Date().toISOString(),
  };

  await atomicWriteJson(needsInputPath, body);

  const db = (ctx.db ?? getDb()) as unknown as {
    insert: (t: unknown) => { values: (v: unknown) => Promise<void> };
  };

  await db.insert(hitlRequests).values({
    id: randomUUID(),
    runId: ctx.runId,
    stepId: step.id,
    kind: "form",
    schema,
    prompt: promptText,
  });

  log.info(
    {
      runId: ctx.runId,
      stepId: step.id,
      needsInputPath,
      schemaPath: resolvedPath,
    },
    "human step wrote needs-input.json + hitl_requests row",
  );

  return {
    ok: false,
    stdout: "",
    vars: {},
    durationMs: Date.now() - startedAt,
    needsInput: true,
  };
}
