import "server-only";

import { eq } from "drizzle-orm";
import pino from "pino";

import { platformRuntimeSettings } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import type { Db } from "@/lib/execution-host/db";

import {
  integrityValueSchema,
  workspaceIntegrityFields,
  type IntegrityField,
  type IntegrityPatch,
  type IntegritySettings,
} from "./settings-schema";

const log = pino({ name: "workspace-integrity.settings", level: process.env.LOG_LEVEL ?? "info" });
const columns = {
  maxSizeMiB: platformRuntimeSettings.workspaceIntegrityMaxSizeMiB,
  maxDurationSeconds: platformRuntimeSettings.workspaceIntegrityMaxDurationSeconds,
  maxEntries: platformRuntimeSettings.workspaceIntegrityMaxEntries,
};
const singleton = eq(platformRuntimeSettings.id, "singleton");
type Overrides = Record<IntegrityField, number | null>;

export function resolveIntegritySettings(
  row: Overrides | undefined,
  env: NodeJS.ProcessEnv = process.env,
): IntegritySettings {
  if (!row)
    throw new MaisterError("CONFIG", "Platform runtime settings are not initialized", {
      details: { reason: "settings_missing" },
    });

  const resolve = (field: IntegrityField): IntegritySettings[IntegrityField] => {
    const definition = workspaceIntegrityFields[field];
    const saved = row[field];
    if (saved !== null) return { value: saved, source: "platform" };
    const raw = env[definition.env];
    if (raw === undefined) return { value: definition.defaultValue, source: "default" };
    const parsed = integrityValueSchema(field).safeParse(/^[0-9]+$/.test(raw) ? Number(raw) : undefined);
    if (!parsed.success)
      throw new MaisterError("CONFIG", "Invalid workspace integrity environment setting", {
        details: { reason: "invalid_environment", field, variable: definition.env },
      });

    return { value: parsed.data, source: "environment" };
  };

  return {
    maxSizeMiB: resolve("maxSizeMiB"),
    maxDurationSeconds: resolve("maxDurationSeconds"),
    maxEntries: resolve("maxEntries"),
  };
}

export async function readIntegritySettings(db: Pick<Db, "select">): Promise<IntegritySettings> {
  const [row] = await db.select(columns).from(platformRuntimeSettings).where(singleton);
  return resolveIntegritySettings(row);
}

export async function updateIntegritySettings(db: Db, patch: IntegrityPatch, actorId: string): Promise<IntegritySettings> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.update(platformRuntimeSettings).set({
      workspaceIntegrityMaxSizeMiB: patch.maxSizeMiB,
      workspaceIntegrityMaxDurationSeconds: patch.maxDurationSeconds,
      workspaceIntegrityMaxEntries: patch.maxEntries,
      updatedAt: new Date(),
    }).where(singleton).returning(columns);

    return resolveIntegritySettings(row);
  });

  log.info({ actorId, changes: patch, effective: result }, "workspace integrity settings updated");

  return result;
}
