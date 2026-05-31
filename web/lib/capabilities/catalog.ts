import "server-only";

import type { Logger } from "pino";
import type {
  CapabilityAgent,
  CapabilityKind,
  MaisterCapabilitiesConfig,
} from "@/lib/config.schema";
import type {
  CapabilityMaterial,
  CapabilityRecordInput,
  LaunchCapabilitySource,
  PlatformMcpCapability,
  ProjectCapabilitiesInput,
  ProjectCapabilityConfig,
} from "@/lib/capabilities/types";

import { randomUUID } from "node:crypto";

import { and, eq, notInArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches executors.ts).
const { capabilityRecords } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "capabilities",
  level: process.env.LOG_LEVEL ?? "info",
});

const selectableKinds = [
  "mcp",
  "skill",
  "rule",
  "setting",
  "restriction",
  "tool",
] as const satisfies readonly CapabilityKind[];

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function sourceForLaunch(
  source: ProjectCapabilityConfig["source"],
): LaunchCapabilitySource {
  if (source === "platform" || source === "system") return "platform";
  if (source === "flow" || source === "flow-package") return "flow-package";

  return "project";
}

function redactedEnv(env: Record<string, string> | undefined): string[] {
  return Object.keys(env ?? {}).sort();
}

function baseMaterial(c: ProjectCapabilityConfig): CapabilityMaterial {
  switch (c.kind) {
    case "mcp":
      return {
        command: c.command ?? null,
        args: c.args ?? [],
        envKeys: redactedEnv(c.env),
        config: c.config ?? {},
      };
    case "skill":
      return {
        url: c.url ?? null,
        path: c.path ?? null,
        hasContent: !!c.content,
      };
    case "rule":
    case "restriction":
      return { path: c.path ?? null, hasContent: !!c.content };
    case "setting":
      return { agent: c.agent, path: c.path };
    case "tool":
      return {};
    default:
      return {};
  }
}

function normalizeCapability(
  c: ProjectCapabilityConfig,
): CapabilityRecordInput {
  return {
    capabilityRefId: c.id,
    kind: c.kind,
    label: c.label ?? c.id,
    source: sourceForLaunch(c.source),
    version: c.version ?? null,
    revision: c.revision ?? null,
    agents: c.agents as
      | CapabilityAgent[]
      | Partial<Record<CapabilityAgent, string>>,
    enforceability: c.enforceability,
    selectedByDefault: c.selected_by_default,
    selectable: c.enforceability !== "unsupported",
    material: baseMaterial(c),
  };
}

export function capabilityInputsFromConfig(
  config: ProjectCapabilitiesInput,
): CapabilityRecordInput[] {
  const projectCapabilities: readonly ProjectCapabilityConfig[] = [
    ...config.mcps,
    ...config.skills,
    ...config.rules,
    ...config.restrictions,
    ...config.settings,
    ...config.tools,
  ];
  const platformCapabilities: readonly ProjectCapabilityConfig[] =
    config.platformMcps ?? [];
  const records = [...platformCapabilities, ...projectCapabilities].map(
    normalizeCapability,
  );
  const seen = new Set<string>();

  for (const record of records) {
    const key = `${record.source}:${record.kind}:${record.capabilityRefId}`;

    if (seen.has(key)) {
      throw new MaisterError(
        "CONFIG",
        `Duplicate capability id "${record.capabilityRefId}" for ${record.source}/${record.kind}`,
      );
    }
    seen.add(key);
  }

  return records;
}

export type UpsertCapabilitiesFromConfigArgs = {
  projectId: string;
  config: MaisterCapabilitiesConfig;
  platformMcps?: PlatformMcpCapability[];
  db?: any;
  logger?: Logger;
};

export type UpsertCapabilitiesFromConfigResult = {
  capabilityIdByRef: Record<string, string>;
  upsertedCount: number;
  disabledScopes: number;
};

function refsByScope(records: readonly CapabilityRecordInput[]) {
  const scopes = new Map<string, Set<string>>();

  for (const record of records) {
    const key = `${record.source}:${record.kind}`;
    const refs = scopes.get(key) ?? new Set<string>();

    refs.add(record.capabilityRefId);
    scopes.set(key, refs);
  }

  return scopes;
}

export async function upsertCapabilitiesFromConfig(
  args: UpsertCapabilitiesFromConfigArgs,
): Promise<UpsertCapabilitiesFromConfigResult> {
  const db = args.db ?? getDb();
  const lg = args.logger ?? log;
  const desired = capabilityInputsFromConfig({
    ...args.config,
    platformMcps: args.platformMcps ?? [],
  });

  lg.info(
    {
      projectId: args.projectId,
      capabilityCount: desired.length,
      mcpCount: desired.filter((c) => c.kind === "mcp").length,
      skillCount: desired.filter((c) => c.kind === "skill").length,
      ruleCount: desired.filter((c) => c.kind === "rule").length,
    },
    "upsertCapabilitiesFromConfig start",
  );

  try {
    return await (db as { transaction: any }).transaction(async (tx: any) => {
      const capabilityIdByRef: Record<string, string> = {};

      for (const record of desired) {
        const rows = await tx
          .insert(capabilityRecords)
          .values({
            id: randomUUID(),
            projectId: args.projectId,
            capabilityRefId: record.capabilityRefId,
            kind: record.kind,
            label: record.label,
            source: record.source,
            version: record.version,
            revision: record.revision,
            agents: record.agents,
            enforceability: record.enforceability,
            selectedByDefault: record.selectedByDefault,
            selectable: record.selectable,
            material: record.material,
            disabledAt: null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              capabilityRecords.projectId,
              capabilityRecords.source,
              capabilityRecords.kind,
              capabilityRecords.capabilityRefId,
            ],
            set: {
              label: record.label,
              source: record.source,
              version: record.version,
              revision: record.revision,
              agents: record.agents,
              enforceability: record.enforceability,
              selectedByDefault: record.selectedByDefault,
              selectable: record.selectable,
              material: record.material,
              disabledAt: null,
              updatedAt: new Date(),
            },
          })
          .returning({ id: capabilityRecords.id });

        const rowId = rows[0]?.id;

        if (!rowId) {
          throw new Error(
            `capability upsert for ${record.kind}/${record.capabilityRefId} returned no row`,
          );
        }

        capabilityIdByRef[
          `${record.source}:${record.kind}:${record.capabilityRefId}`
        ] = rowId;
        lg.debug(
          {
            projectId: args.projectId,
            source: record.source,
            kind: record.kind,
            capabilityRefId: record.capabilityRefId,
            enforceability: record.enforceability,
            selectedByDefault: record.selectedByDefault,
          },
          "capability upserted",
        );
      }

      const scopes = refsByScope(desired);
      let disabledScopes = 0;

      for (const source of ["platform", "project", "flow-package"] as const) {
        for (const kind of selectableKinds) {
          const key = `${source}:${kind}`;
          const refs = [...(scopes.get(key) ?? [])];
          const where =
            refs.length > 0
              ? and(
                  eq(capabilityRecords.projectId, args.projectId),
                  eq(capabilityRecords.source, source),
                  eq(capabilityRecords.kind, kind),
                  notInArray(capabilityRecords.capabilityRefId, refs),
                )
              : and(
                  eq(capabilityRecords.projectId, args.projectId),
                  eq(capabilityRecords.source, source),
                  eq(capabilityRecords.kind, kind),
                );

          await tx
            .update(capabilityRecords)
            .set({
              selectable: false,
              disabledAt: new Date(),
              updatedAt: new Date(),
            })
            .where(where);
          disabledScopes += 1;
        }
      }

      lg.info(
        {
          projectId: args.projectId,
          upsertedCount: desired.length,
          disabledScopes,
        },
        "upsertCapabilitiesFromConfig done",
      );

      return {
        capabilityIdByRef,
        upsertedCount: desired.length,
        disabledScopes,
      };
    });
  } catch (err) {
    if (err instanceof MaisterError) throw err;
    throw new MaisterError(
      "CONFIG",
      `upsertCapabilitiesFromConfig failed: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }
}
