import "server-only";

import { eq } from "drizzle-orm";
import pino from "pino";

import { platformRuntimeSettings } from "@/lib/db/schema";
import { MaisterError, isMaisterError } from "@/lib/errors";
import type { Db } from "@/lib/execution-host/db";

import {
  integrityValueSchema,
  workspaceIntegrityFields,
  workspaceIntegrityFieldNames,
  type IntegrityField,
  type IntegrityPatch,
  type IntegritySettings,
} from "./settings-schema";

const log = pino({
  name: "workspace-integrity.settings",
  level: process.env.LOG_LEVEL ?? "info",
});
const columns = {
  maxSizeMiB: platformRuntimeSettings.workspaceIntegrityMaxSizeMiB,
  maxDurationSeconds:
    platformRuntimeSettings.workspaceIntegrityMaxDurationSeconds,
  maxEntries: platformRuntimeSettings.workspaceIntegrityMaxEntries,
};
const singleton = eq(platformRuntimeSettings.id, "singleton");
type Overrides = Record<IntegrityField, number | null>;
const inherited: Readonly<Overrides> = {
  maxSizeMiB: null,
  maxDurationSeconds: null,
  maxEntries: null,
};

function resolveField(
  row: Overrides,
  field: IntegrityField,
  env: NodeJS.ProcessEnv,
): IntegritySettings[IntegrityField] {
  const definition = workspaceIntegrityFields[field];
  const saved = row[field];
  if (saved !== null) return { value: saved, source: "platform" };
  const raw = env[definition.env];
  if (raw === undefined)
    return { value: definition.defaultValue, source: "default" };
  const parsed = integrityValueSchema(field).safeParse(
    /^[0-9]+$/.test(raw) ? Number(raw) : undefined,
  );
  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Invalid workspace integrity environment setting",
      {
        details: {
          reason: "invalid_environment",
          field,
          variable: definition.env,
        },
      },
    );

  return { value: parsed.data, source: "environment" };
}

export function resolveIntegritySettings(
  row: Overrides | undefined,
  env: NodeJS.ProcessEnv = process.env,
): IntegritySettings {
  if (!row)
    throw new MaisterError(
      "CONFIG",
      "Platform runtime settings are not initialized",
      {
        details: { reason: "settings_missing" },
      },
    );

  return {
    maxSizeMiB: resolveField(row, "maxSizeMiB", env),
    maxDurationSeconds: resolveField(row, "maxDurationSeconds", env),
    maxEntries: resolveField(row, "maxEntries", env),
  };
}

export function integritySettingsPageView(row: Overrides | undefined): {
  settings: Partial<IntegritySettings> | null;
  invalidFields: IntegrityField[];
} {
  if (!row) return { settings: null, invalidFields: [] };
  const settings: Partial<IntegritySettings> = {};
  const invalidFields: IntegrityField[] = [];
  for (const field of workspaceIntegrityFieldNames) {
    try {
      settings[field] = resolveField(row, field, process.env);
    } catch (error) {
      if (
        !isMaisterError(error) ||
        error.details?.reason !== "invalid_environment"
      )
        throw error;
      invalidFields.push(field);
    }
  }
  return { settings, invalidFields };
}

async function readOverrides(
  db: Pick<Db, "select">,
): Promise<Overrides | undefined> {
  const [row] = await db
    .select(columns)
    .from(platformRuntimeSettings)
    .where(singleton);
  return row;
}

export async function readIntegritySettings(
  db: Pick<Db, "select">,
): Promise<IntegritySettings> {
  return resolveIntegritySettings(await readOverrides(db));
}

/** Explicit-runner launches can precede native platform runner bootstrap. */
export async function readIntegrityCheckSettings(
  db: Pick<Db, "select">,
): Promise<IntegritySettings> {
  return resolveIntegritySettings((await readOverrides(db)) ?? inherited);
}

export async function updateIntegritySettings(
  db: Db,
  patch: IntegrityPatch,
  actorId: string,
): Promise<IntegritySettings> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(platformRuntimeSettings)
      .set({
        workspaceIntegrityMaxSizeMiB: patch.maxSizeMiB,
        workspaceIntegrityMaxDurationSeconds: patch.maxDurationSeconds,
        workspaceIntegrityMaxEntries: patch.maxEntries,
        updatedAt: new Date(),
      })
      .where(singleton)
      .returning(columns);

    return resolveIntegritySettings(row);
  });

  log.info(
    { actorId, changes: patch, effective: result },
    "workspace integrity settings updated",
  );

  return result;
}
