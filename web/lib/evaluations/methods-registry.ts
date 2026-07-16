import "server-only";

import type {
  EvaluationMethodCompat,
  EvaluationMethodHealth,
} from "@/lib/evaluations/types";

import { join } from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { sha256, stableStringify } from "./digest";
import { checkMethodEngineCompatibility, loadEvaluationMethod } from "./method";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { MAISTER_ENGINE_VERSION } from "@/lib/flows/engine-version";

// FIXME(any): schema-module bridge (matches lib/evaluations/config.ts).
const { evaluationMethodRevisions, packageInstalls } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluation-methods-registry",
  level: process.env.LOG_LEVEL ?? "info",
});

type MethodManifestEntry = { id: string; path: string };

type InstallRow = {
  id: string;
  name: string;
  versionLabel: string;
  installedPath: string;
  packageStatus: string;
  trustStatus: string;
  // Stored PackageInstallManifest ({ spec: MaisterPackageManifest, inventory }).
  manifest: {
    spec?: { evaluationMethods?: MethodManifestEntry[] };
  } | null;
};

export type MethodProjectionIssue = {
  readonly methodId: string;
  readonly path: string;
  readonly error: string;
};

export type MethodProjectionSummary = {
  packageName: string;
  versionLabel: string;
  projected: string[];
  invalid: MethodProjectionIssue[];
};

// Derived health (D8): never persisted. `incompatible` when the projection
// failed strict validation or the engine range excludes this engine;
// `degraded` when the providing package is untrusted (a valid method that
// cannot yet execute); `ready` only when trusted + compatible + error-free.
export function deriveMethodHealth(
  row: {
    validationErrors?: string[] | null;
    compat: EvaluationMethodCompat;
  },
  trustStatus: string,
): EvaluationMethodHealth {
  if (row.validationErrors && row.validationErrors.length > 0) {
    return "incompatible";
  }

  const compat = checkMethodEngineCompatibilityFromCompat(row.compat);

  if (!compat.compatible) return "incompatible";
  if (trustStatus !== "trusted") return "degraded";

  return "ready";
}

// Engine compat over the stored compat range (mirrors method.ts, which reads
// the live method definition). Kept here so the derived-health read never needs
// to re-load the YAML off disk.
function checkMethodEngineCompatibilityFromCompat(
  compat: EvaluationMethodCompat,
): {
  compatible: boolean;
} {
  return checkMethodEngineCompatibility({
    id: "projected",
    compat: {
      engine_min: compat.engineMin,
      engine_max: compat.engineMax ?? undefined,
    },
  } as never);
}

async function loadInstall(
  db: Db,
  packageInstallId: string,
): Promise<InstallRow> {
  const rows = (await db
    .select({
      id: packageInstalls.id,
      name: packageInstalls.name,
      versionLabel: packageInstalls.versionLabel,
      installedPath: packageInstalls.installedPath,
      packageStatus: packageInstalls.packageStatus,
      trustStatus: packageInstalls.trustStatus,
      manifest: packageInstalls.manifest,
    })
    .from(packageInstalls)
    .where(eq(packageInstalls.id, packageInstallId))) as InstallRow[];
  const install = rows[0];

  if (!install) {
    throw new MaisterError(
      "PRECONDITION",
      `package install ${packageInstallId} not found`,
    );
  }

  return install;
}

// The synced (SET/CLEAR-symmetric) columns for one projected method revision.
// Every column is written on every projection; `activation` is runtime state and
// is NOT touched here (default `disabled` on first insert, ADR-140 D7 — a method
// only becomes selectable after an explicit trusted+compatible activation).
function methodRow(
  install: InstallRow,
  methodId: string,
  loaded: {
    schemaVersion: number;
    normalizedDefinition: Record<string, unknown>;
    definitionDigest: string;
    promptDigest: string;
    schemaDigest: string;
    compat: EvaluationMethodCompat;
  },
  validationErrors: string[] | null,
): Record<string, unknown> {
  return {
    packageInstallId: install.id,
    methodId,
    qualifiedId: `${install.name}:${methodId}`,
    packageName: install.name,
    versionLabel: install.versionLabel,
    schemaVersion: loaded.schemaVersion,
    normalizedDefinition: loaded.normalizedDefinition,
    definitionDigest: loaded.definitionDigest,
    promptDigest: loaded.promptDigest,
    schemaDigest: loaded.schemaDigest,
    compat: loaded.compat,
    validationErrors,
    updatedAt: new Date(),
  };
}

// An invalid method (strict-validation/asset failure) is still projected as a
// report-only revision so the Methodologies admin surface can show it with a
// reason; placeholder digests keep the NOT NULL contract, and the non-empty
// `validationErrors` makes it never selectable (deriveMethodHealth →
// incompatible).
function invalidPlaceholder(): {
  schemaVersion: number;
  normalizedDefinition: Record<string, unknown>;
  definitionDigest: string;
  promptDigest: string;
  schemaDigest: string;
  compat: EvaluationMethodCompat;
} {
  return {
    schemaVersion: 1,
    normalizedDefinition: {},
    definitionDigest: "",
    promptDigest: "",
    schemaDigest: "",
    compat: { engineMin: MAISTER_ENGINE_VERSION },
  };
}

// Project every `evaluationMethods[]` entry shipped by an installed PACKAGE into
// `evaluation_method_revisions`, keyed by (packageInstallId, methodId) so each
// install revision carries its own immutable method revision (ADR-140 D6/D8).
// INERT: no package content executes; loadEvaluationMethod only parses/hashes.
// Invalid methods are projected report-only (never selectable), never fail the
// surrounding install.
export async function registerPackageMethods(
  packageInstallId: string,
  db?: Db,
): Promise<MethodProjectionSummary> {
  const _db = db ?? getDb();
  const install = await loadInstall(_db, packageInstallId);

  if (install.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `package install ${packageInstallId} is ${install.packageStatus}, not Installed`,
    );
  }

  const entries = install.manifest?.spec?.evaluationMethods ?? [];
  const projected: string[] = [];
  const invalid: MethodProjectionIssue[] = [];

  for (const entry of entries) {
    const qualifiedId = `${install.name}:${entry.id}`;
    let row: Record<string, unknown>;

    try {
      const loaded = await loadEvaluationMethod(
        join(install.installedPath, entry.path),
      );

      if (loaded.definition.id !== entry.id) {
        throw new MaisterError(
          "CONFIG",
          `method id "${loaded.definition.id}" does not match manifest entry "${entry.id}"`,
        );
      }

      row = methodRow(
        install,
        entry.id,
        {
          schemaVersion: loaded.definition.schemaVersion,
          normalizedDefinition: {
            definition: loaded.definition,
            criteria: loaded.criteria,
          },
          definitionDigest: loaded.definitionDigest,
          promptDigest: sha256(stableStringify(loaded.promptDigests)),
          schemaDigest: loaded.resultSchemaDigest,
          compat: {
            engineMin:
              loaded.definition.compat.engine_min ?? MAISTER_ENGINE_VERSION,
            engineMax: loaded.definition.compat.engine_max ?? null,
          },
        },
        null,
      );
      projected.push(qualifiedId);
    } catch (err) {
      const message =
        err instanceof MaisterError
          ? err.message
          : "evaluation method could not be read or validated";

      row = methodRow(install, entry.id, invalidPlaceholder(), [message]);
      invalid.push({ methodId: entry.id, path: entry.path, error: message });
      log.warn(
        {
          qualifiedId,
          packageInstallId,
          path: entry.path,
          issue: err instanceof Error ? err.message : String(err),
        },
        "invalid evaluation method projected as report-only",
      );
    }

    await _db
      .insert(evaluationMethodRevisions)
      .values(row)
      .onConflictDoUpdate({
        target: [
          evaluationMethodRevisions.packageInstallId,
          evaluationMethodRevisions.methodId,
        ],
        set: row,
      });
  }

  if (projected.length > 0 || invalid.length > 0) {
    log.info(
      {
        packageName: install.name,
        versionLabel: install.versionLabel,
        projected: projected.length,
        invalid: invalid.length,
      },
      "evaluation methods projected from package install",
    );
  }

  return {
    packageName: install.name,
    versionLabel: install.versionLabel,
    projected,
    invalid,
  };
}

export type MethodResyncSummary = {
  ok: true;
  projected: number;
  invalid: MethodProjectionIssue[];
};

// Re-project every installed package's methods. Unlike the agent catalog,
// method revisions are per-install immutable rows (each install versionLabel is
// its own revision, D8), so there is no newest-per-name collapse and no missing
// disable — a revision row is anchored to its packageInstallId (RESTRICT).
export async function resyncMethods(db?: Db): Promise<MethodResyncSummary> {
  const _db = db ?? getDb();

  const installRows = (await _db
    .select({ id: packageInstalls.id })
    .from(packageInstalls)
    .where(eq(packageInstalls.packageStatus, "Installed"))) as Array<{
    id: string;
  }>;

  const invalid: MethodProjectionIssue[] = [];
  let projected = 0;

  for (const { id } of installRows) {
    const summary = await registerPackageMethods(id, _db);

    projected += summary.projected.length;
    invalid.push(...summary.invalid);
  }

  log.info(
    { projected, invalid: invalid.length },
    "evaluation method catalog resynced from installed packages",
  );

  return { ok: true, projected, invalid };
}

export type MethodologyListItem = {
  id: string;
  qualifiedId: string;
  methodId: string;
  packageName: string;
  versionLabel: string;
  packageInstallId: string;
  schemaVersion: number;
  compat: EvaluationMethodCompat;
  activation: "enabled" | "disabled";
  health: EvaluationMethodHealth;
  validationErrors: string[] | null;
  trustStatus: string;
  updatedAt: Date;
};

// The admin Methodologies list: every projected revision with its derived
// health, package trust, and validation errors. Never exposes installed_path,
// prompt/schema bodies, or secrets — only the display + provenance surface.
export async function listMethodologies(
  db?: Db,
): Promise<MethodologyListItem[]> {
  const _db = db ?? getDb();

  const rows = (await _db
    .select({
      id: evaluationMethodRevisions.id,
      qualifiedId: evaluationMethodRevisions.qualifiedId,
      methodId: evaluationMethodRevisions.methodId,
      packageName: evaluationMethodRevisions.packageName,
      versionLabel: evaluationMethodRevisions.versionLabel,
      packageInstallId: evaluationMethodRevisions.packageInstallId,
      schemaVersion: evaluationMethodRevisions.schemaVersion,
      compat: evaluationMethodRevisions.compat,
      activation: evaluationMethodRevisions.activation,
      validationErrors: evaluationMethodRevisions.validationErrors,
      updatedAt: evaluationMethodRevisions.updatedAt,
      trustStatus: packageInstalls.trustStatus,
    })
    .from(evaluationMethodRevisions)
    .innerJoin(
      packageInstalls,
      eq(evaluationMethodRevisions.packageInstallId, packageInstalls.id),
    )) as Array<Omit<MethodologyListItem, "health">>;

  return rows.map((r) => ({
    ...r,
    health: deriveMethodHealth(r, r.trustStatus),
  }));
}

// Activation toggle (admin). Enabling is gated on a ready health (trusted +
// compatible + error-free) — a degraded/incompatible method can never be
// enabled, so it can never drive capture/prompts/aggregation. Disabling is
// always allowed (an ops kill switch that never deletes history, D8).
export async function setMethodActivation(
  args: { methodRevisionId: string; activation: "enabled" | "disabled" },
  db?: Db,
): Promise<{
  activation: "enabled" | "disabled";
  health: EvaluationMethodHealth;
}> {
  const _db = db ?? getDb();

  const rows = (await _db
    .select({
      id: evaluationMethodRevisions.id,
      compat: evaluationMethodRevisions.compat,
      validationErrors: evaluationMethodRevisions.validationErrors,
      trustStatus: packageInstalls.trustStatus,
    })
    .from(evaluationMethodRevisions)
    .innerJoin(
      packageInstalls,
      eq(evaluationMethodRevisions.packageInstallId, packageInstalls.id),
    )
    .where(eq(evaluationMethodRevisions.id, args.methodRevisionId))) as Array<{
    id: string;
    compat: EvaluationMethodCompat;
    validationErrors: string[] | null;
    trustStatus: string;
  }>;
  const row = rows[0];

  if (!row) {
    throw new MaisterError(
      "PRECONDITION",
      `method revision not found: ${args.methodRevisionId}`,
    );
  }

  const health = deriveMethodHealth(row, row.trustStatus);

  if (args.activation === "enabled" && health !== "ready") {
    throw new MaisterError(
      "CONFIG",
      `method revision ${args.methodRevisionId} is ${health}; only a ready (trusted + compatible) method can be enabled`,
    );
  }

  await _db
    .update(evaluationMethodRevisions)
    .set({ activation: args.activation, updatedAt: new Date() })
    .where(eq(evaluationMethodRevisions.id, args.methodRevisionId));

  log.info(
    { methodRevisionId: args.methodRevisionId, activation: args.activation },
    "evaluation method activation updated",
  );

  return { activation: args.activation, health };
}
