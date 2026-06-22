import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { runtimeRoot } from "@/lib/instance-config";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, projects } = schemaModule as unknown as Record<string, any>;

// FR-A2/A3: a live availableCommands entry, names AS-EMITTED by the adapter
// (codex bakes `$`; claude bare / `mcp:`). The composer maps to canonical refs.
export type AvailableCommandDto = {
  name: string;
  description: string | null;
  hint: string | null;
};

function toDto(cmd: unknown): AvailableCommandDto | null {
  if (!cmd || typeof cmd !== "object") return null;

  const record = cmd as Record<string, unknown>;

  if (typeof record.name !== "string") return null;

  const input = record.input;
  const hint =
    input &&
    typeof input === "object" &&
    typeof (input as any).hint === "string"
      ? ((input as any).hint as string)
      : null;

  return {
    name: record.name,
    description:
      typeof record.description === "string" ? record.description : null,
    hint,
  };
}

function sessionUpdateFromEvent(parsed: any): any {
  if (parsed?.type === "session.update") return parsed.update;

  if (parsed?.type !== "session.line" || typeof parsed.line !== "string") {
    return null;
  }

  let rpc: any;

  try {
    rpc = JSON.parse(parsed.line);
  } catch {
    return null;
  }

  if (rpc?.method !== "session/update") return null;

  return rpc?.params?.update ?? null;
}

/**
 * Extract the LATEST `available_commands_update` snapshot from a run's
 * `run.events.jsonl` content (FR-A1 last-write-wins). Pure — no fs. The supervisor
 * appends every `session.update` to the log, so the snapshot is recoverable
 * without separate persistence. A cheap substring check fast-paths the parse.
 */
export function extractLatestAvailableCommands(
  rawJsonl: string,
): AvailableCommandDto[] {
  let latest: unknown[] | null = null;

  for (const line of rawJsonl.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || !trimmed.includes("available_commands_update")) continue;

    let parsed: any;

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const update = sessionUpdateFromEvent(parsed);

    if (
      update?.sessionUpdate === "available_commands_update" &&
      Array.isArray(update.availableCommands)
    ) {
      latest = update.availableCommands;
    }
  }

  if (!latest) return [];

  return latest
    .map(toDto)
    .filter((command): command is AvailableCommandDto => command !== null);
}

/**
 * Read the latest availableCommands snapshot for a scratch run from its durable
 * event log. Returns `[]` when the run/slug or log file is absent (a session
 * that has not emitted the event yet).
 */
export async function readScratchAvailableCommands(
  runId: string,
  db: any = getDb(),
): Promise<AvailableCommandDto[]> {
  const slugRows = await db
    .select({ slug: projects.slug })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId))
    .limit(1);
  const slug = (slugRows[0] as { slug: string } | undefined)?.slug;

  if (!slug) return [];

  const eventsLogPath = path.join(
    runtimeRoot(),
    ".maister",
    slug,
    "runs",
    runId,
    "run.events.jsonl",
  );

  let raw: string;

  try {
    raw = await readFile(eventsLogPath, "utf8");
  } catch {
    return [];
  }

  return extractLatestAvailableCommands(raw);
}
