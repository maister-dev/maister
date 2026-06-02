import "server-only";

import type { FlowContext, StepResult } from "./types";

import { randomUUID } from "node:crypto";
import { readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { renderStrict } from "./templating";

import { atomicWriteJson } from "@/lib/atomic";
import { createHitlAssignmentForRun } from "@/lib/assignments/service";
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

type DbLike = {
  insert: (table: unknown) => {
    values: (row: Record<string, unknown>) => unknown;
  };
  select: () => unknown;
  transaction?: <T>(fn: (tx: DbLike) => Promise<T>) => Promise<T>;
};

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

async function tryReadInputArtifact(
  inputPath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(inputPath, "utf8");

    try {
      const parsed = JSON.parse(raw) as unknown;

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new MaisterError(
        "CONFIG",
        `input artifact at ${inputPath} is not a JSON object`,
      );
    } catch (err) {
      if (err instanceof MaisterError) throw err;
      throw new MaisterError(
        "CONFIG",
        `input artifact at ${inputPath} is not valid JSON: ${(err as Error).message}`,
        { cause: err as Error },
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (err instanceof MaisterError) throw err;
    throw new MaisterError(
      "CONFIG",
      `failed to read input artifact at ${inputPath}: ${(err as Error).message}`,
      { cause: err as Error },
    );
  }
}

export async function runHumanStep(
  step: HumanStepLike,
  ctx: RunHumanStepCtx,
): Promise<StepResult & { needsInput: boolean }> {
  const startedAt = Date.now();
  const inputArtifactPath = path.join(
    ctx.runtimeRoot,
    ".maister",
    ctx.projectSlug,
    "runs",
    ctx.runId,
    `input-${step.id}.json`,
  );
  const existingInput = await tryReadInputArtifact(inputArtifactPath);

  if (existingInput) {
    log.info(
      {
        runId: ctx.runId,
        stepId: step.id,
        inputArtifactPath,
        resumeFromArtifact: true,
      },
      "human step resume from existing input artifact",
    );

    return {
      ok: true,
      stdout: "",
      vars: existingInput,
      durationMs: Date.now() - startedAt,
      needsInput: false,
    };
  }

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

  const db = (ctx.db ?? getDb()) as DbLike;

  const kind: "form" | "human" = step.on_reject ? "human" : "form";
  const hitlRequestId = randomUUID();

  const persistHitlRequestAndAssignment = async (tx: DbLike): Promise<void> => {
    await tx.insert(hitlRequests).values({
      id: hitlRequestId,
      runId: ctx.runId,
      stepId: step.id,
      kind,
      schema,
      prompt: promptText,
    });
    await createHitlAssignmentForRun({
      db: tx,
      runId: ctx.runId,
      hitlRequestId,
      stepId: step.id,
      actionKind: "form",
      roleRefs: [],
      title: promptText,
    });
  };

  try {
    if (typeof db.transaction === "function") {
      await db.transaction(persistHitlRequestAndAssignment);
    } else {
      await persistHitlRequestAndAssignment(db);
    }
  } catch (err) {
    await unlink(needsInputPath).catch((cleanupErr: unknown) => {
      log.error(
        {
          runId: ctx.runId,
          stepId: step.id,
          needsInputPath,
          err: (err as Error).message,
          cleanupErr: (cleanupErr as Error).message,
        },
        "[FIX:M13] failed to remove needs-input.json after HITL assignment persistence failure",
      );
    });
    throw err;
  }

  log.info(
    {
      runId: ctx.runId,
      stepId: step.id,
      hitlRequestId,
      needsInputPath,
      schemaPath: resolvedPath,
    },
    "[FIX:M13] human step wrote needs-input.json + HITL assignment",
  );

  return {
    ok: false,
    stdout: "",
    vars: {},
    durationMs: Date.now() - startedAt,
    needsInput: true,
  };
}
