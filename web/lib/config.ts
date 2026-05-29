import "server-only";

import { readFile } from "node:fs/promises";

import Mustache from "mustache";
import pino from "pino";
import { parse as parseYaml } from "yaml";

import {
  flowYamlV1Schema,
  formSchemaSchema,
  maisterYamlV2Schema,
  type FlowYamlV1,
  type MaisterYamlV2,
} from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";

const log = pino({ name: "config" });

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export async function loadProjectConfig(
  maisterYamlPath: string,
): Promise<MaisterYamlV2> {
  let raw: string;

  try {
    raw = await readFile(maisterYamlPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Cannot read maister.yaml at ${maisterYamlPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Invalid YAML in ${maisterYamlPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  const parsed = maisterYamlV2Schema.safeParse(data);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");

    log.warn(
      { path: maisterYamlPath, issues },
      "maister.yaml validation failed",
    );
    throw new MaisterError(
      "CONFIG",
      `maister.yaml schema errors in ${maisterYamlPath}: ${issues}`,
    );
  }

  const cfg = parsed.data;

  log.debug(
    {
      path: maisterYamlPath,
      executors: cfg.executors.length,
      flows: cfg.flows.length,
    },
    "maister.yaml loaded",
  );

  const executorIds = new Set<string>();

  for (const ex of cfg.executors) {
    if (executorIds.has(ex.id)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate executor id "${ex.id}" in ${maisterYamlPath}`,
      );
    }
    executorIds.add(ex.id);
  }

  if (!executorIds.has(cfg.default_executor)) {
    throw new MaisterError(
      "CONFIG",
      `default_executor "${cfg.default_executor}" not found in executors[] of ${maisterYamlPath}`,
    );
  }

  const flowIds = new Set<string>();

  for (const f of cfg.flows) {
    if (flowIds.has(f.id)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate flow id "${f.id}" in ${maisterYamlPath}`,
      );
    }
    flowIds.add(f.id);

    if (f.executor_override && !executorIds.has(f.executor_override)) {
      throw new MaisterError(
        "CONFIG",
        `Flow "${f.id}" executor_override "${f.executor_override}" not found in executors[] of ${maisterYamlPath}`,
      );
    }
  }

  return cfg;
}

export async function loadFlowManifest(
  flowYamlPath: string,
): Promise<FlowYamlV1> {
  let raw: string;

  try {
    raw = await readFile(flowYamlPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Cannot read flow.yaml at ${flowYamlPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Invalid YAML in ${flowYamlPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  const parsed = flowYamlV1Schema.safeParse(data);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");

    log.warn({ path: flowYamlPath, issues }, "flow.yaml validation failed");
    throw new MaisterError(
      "CONFIG",
      `flow.yaml schema errors in ${flowYamlPath}: ${issues}`,
    );
  }

  const manifest = parsed.data;

  log.debug(
    {
      path: flowYamlPath,
      steps: manifest.steps.length,
      contract: {
        compat: manifest.compat,
        capabilities: manifest.capabilities?.length ?? 0,
        gates: manifest.gates?.length ?? 0,
        artifacts: manifest.artifacts?.length ?? 0,
        externalOps: manifest.external_ops?.length ?? 0,
      },
    },
    "flow.yaml loaded",
  );

  const stepIds = new Set<string>();

  for (const s of manifest.steps) {
    if (stepIds.has(s.id)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate step id "${s.id}" in ${flowYamlPath}`,
      );
    }
    stepIds.add(s.id);
  }

  for (const s of manifest.steps) {
    if (s.type === "human" && s.on_reject?.goto_step) {
      if (!stepIds.has(s.on_reject.goto_step)) {
        throw new MaisterError(
          "CONFIG",
          `Step "${s.id}" on_reject.goto_step "${s.on_reject.goto_step}" not found in steps[] of ${flowYamlPath}`,
        );
      }
    }
  }

  for (const s of manifest.steps) {
    let template: string | undefined;

    if (s.type === "agent") template = s.prompt;
    else if (s.type === "cli") template = s.command;

    if (template === undefined) continue;

    try {
      Mustache.parse(template);
      log.debug(
        { path: flowYamlPath, stepId: s.id, type: s.type },
        "template parse-ok",
      );
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `flow.yaml step ${s.id}: invalid mustache template — ${asError(err).message}`,
        { cause: asError(err) },
      );
    }
  }

  return manifest;
}

export function validateFormSchemaVersion(
  formSchema: unknown,
  expectedVersion: number,
): void {
  const parsed = formSchemaSchema.safeParse(formSchema);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `Invalid form_schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  if (parsed.data.schemaVersion !== expectedVersion) {
    throw new MaisterError(
      "CONFIG",
      `form_schema version mismatch: expected ${expectedVersion}, got ${parsed.data.schemaVersion}`,
    );
  }
}
