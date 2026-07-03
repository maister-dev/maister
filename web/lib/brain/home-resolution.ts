import "server-only";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import type { BrainItemKind } from "./schema";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "brain:home-resolution",
  level: process.env.LOG_LEVEL ?? "info",
});

const HOME_KINDS = ["decision", "direction"] as const;
const HOME_VALUES = ["owned", "indexed"] as const;

export type BrainHomeKind = (typeof HOME_KINDS)[number];
export type BrainHomeValue = (typeof HOME_VALUES)[number];
export type BrainHomeResolution = Partial<Record<BrainHomeKind, BrainHomeValue>>;

type HomeResolutionDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface BrainHome {
  kind: BrainHomeKind;
  value: BrainHomeValue;
  sourceId: string | null;
  sourcePath: string | null;
}

function isHomeKind(kind: BrainItemKind): kind is BrainHomeKind {
  return (HOME_KINDS as readonly string[]).includes(kind);
}

function isHomeValue(value: unknown): value is BrainHomeValue {
  return (HOME_VALUES as readonly unknown[]).includes(value);
}

function explicitHomeValue(
  resolution: Record<string, unknown>,
  kind: BrainHomeKind,
): BrainHomeValue | null {
  const value = resolution[kind];

  if (isHomeValue(value)) return value;

  if (value && typeof value === "object" && "home" in value) {
    const home = (value as { home?: unknown }).home;

    if (isHomeValue(home)) return home;
  }

  return null;
}

function explicitSourcePath(
  resolution: Record<string, unknown>,
  kind: BrainHomeKind,
): string | null {
  const value = resolution[kind];

  if (value && typeof value === "object" && "sourcePath" in value) {
    const sourcePath = (value as { sourcePath?: unknown }).sourcePath;

    if (typeof sourcePath === "string" && sourcePath.trim().length > 0) {
      return sourcePath;
    }
  }

  return null;
}

function normalizedResolution(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizedPath(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/");
}

function sourceCoversKind(path: string, kind: BrainHomeKind): boolean {
  const p = normalizedPath(path);

  if (kind === "decision") {
    return (
      p === "docs/decisions.md" ||
      p.includes("/decisions.") ||
      p.includes("adr") ||
      p.includes("decision")
    );
  }

  return (
    p.endsWith("roadmap.md") ||
    p.endsWith("vision.md") ||
    p.endsWith("product_view.md") ||
    p.endsWith("product-view.md") ||
    p.includes("roadmap") ||
    p.includes("direction") ||
    p.includes("strategy")
  );
}

function assertHomeResolutionInput(
  input: BrainHomeResolution,
): BrainHomeResolution {
  for (const [kind, value] of Object.entries(input)) {
    if (!(HOME_KINDS as readonly string[]).includes(kind)) {
      throw new MaisterError(
        "CONFIG",
        `unknown homeResolution kind: ${kind}`,
      );
    }

    if (!isHomeValue(value)) {
      throw new MaisterError(
        "CONFIG",
        `invalid homeResolution value for ${kind}: ${String(value)}`,
      );
    }
  }

  return input;
}

export async function saveBrainHomeResolution(
  db: HomeResolutionDb,
  projectId: string,
  input: BrainHomeResolution,
): Promise<BrainHomeResolution> {
  const resolution = assertHomeResolutionInput(input);

  await db.execute(sql`
    INSERT INTO brain_project_config (project_id, home_resolution)
    VALUES (${projectId}, ${JSON.stringify(resolution)}::jsonb)
    ON CONFLICT (project_id)
    DO UPDATE SET home_resolution = EXCLUDED.home_resolution,
                  updated_at = now()
  `);

  return resolution;
}

export async function resolveBrainHome(
  db: HomeResolutionDb,
  projectId: string,
  kind: BrainItemKind,
): Promise<BrainHome | null> {
  if (!isHomeKind(kind)) return null;

  const config = await db.execute(sql`
    SELECT home_resolution
    FROM brain_project_config
    WHERE project_id = ${projectId}
  `);
  const resolution = normalizedResolution(config.rows[0]?.home_resolution);
  const explicit = explicitHomeValue(resolution, kind);
  const sources = await db.execute(sql`
    SELECT id, path
    FROM brain_sources
    WHERE project_id = ${projectId} AND enabled = true
    ORDER BY path ASC, created_at ASC
  `);
  const source =
    sources.rows.find((row) => sourceCoversKind(String(row.path), kind)) ??
    null;

  if (explicit === "owned") {
    return { kind, value: "owned", sourceId: null, sourcePath: null };
  }

  if (explicit === "indexed") {
    return {
      kind,
      value: "indexed",
      sourceId: source ? String(source.id) : null,
      sourcePath:
        (source ? String(source.path) : explicitSourcePath(resolution, kind)) ??
        null,
    };
  }

  if (source) {
    return {
      kind,
      value: "indexed",
      sourceId: String(source.id),
      sourcePath: String(source.path),
    };
  }

  return { kind, value: "owned", sourceId: null, sourcePath: null };
}

export async function assertRetainHomeAllowsOwned(
  db: HomeResolutionDb,
  projectId: string,
  kind: BrainItemKind,
): Promise<void> {
  const home = await resolveBrainHome(db, projectId, kind);

  if (!home || home.value === "owned") return;

  log.warn(
    { projectId, kind, sourceId: home.sourceId },
    "brain retain refused by home resolution",
  );

  const canonical = home.sourcePath ?? `${kind} canonical source`;

  throw new MaisterError(
    "CONFIG",
    `${kind} memory is indexed-tier for this project; update ${canonical} through memory_propose instead of memory_retain`,
  );
}
