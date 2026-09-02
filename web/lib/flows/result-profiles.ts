import type { FormSchema } from "@/lib/config.schema";

import { createHash } from "node:crypto";

import { readFormSchemaDocWithBytes } from "@/lib/config";
import { OUTPUT_COORDINATOR_ENGINE_MIN } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";
import { schemaDocUsesCoordinatorGrammar } from "@/lib/flows/artifact-validate";
import { semverGte } from "@/lib/flows/engine-version";
import { isRootSchemaFilePath } from "@/lib/flows/editor/reference-sources";

// ADR-165 (D4): a package's named agent result contracts, resolved at INSTALL
// into `flow_revisions.result_profiles` for every member flow. ONE resolver,
// shared by the installer and the Studio lifecycle validator — a second copy is
// how the two surfaces drift and a package that installs stops validating.

/** The persisted per-profile shape (`flow_revisions.result_profiles` value). */
export type ResolvedResultProfile = {
  schemaPath: string;
  schemaStem: string;
  schemaVersion: number;
  sha256: string;
  schema: FormSchema;
};

export type ResultProfileMap = Record<string, ResolvedResultProfile>;

/** The manifest-side declaration: `result_profiles: { <name>: { schema } }`. */
export type DeclaredResultProfiles = Record<string, { schema: string }>;

/** `./schemas/research-result.v1.json` -> `research-result.v1`. */
export function schemaStemOf(schemaPath: string): string {
  const file = schemaPath.trim().replace(/^\.\//, "").split("/").pop() ?? "";

  return file.replace(/\.json$/, "");
}

/**
 * Resolve ONE declared profile against an installed flow revision's dir.
 *
 * Every failure is `FLOW_INSTALL` so the caller's existing failure handling
 * flips the revision to `Failed` — a half-resolved map is never written.
 */
export async function resolveProfileDoc(args: {
  readonly installedPath: string;
  readonly name: string;
  readonly schemaPath: string;
  /** The MEMBER flow's declared floor — the lowest member wins across a package. */
  readonly engineMin: string;
}): Promise<ResolvedResultProfile> {
  const { installedPath, name, schemaPath, engineMin } = args;

  if (schemaPath !== schemaPath.trim() || !isRootSchemaFilePath(schemaPath)) {
    throw new MaisterError(
      "FLOW_INSTALL",
      `result_profiles.${name}.schema must resolve to a package-root schemas/<name>.json: ${schemaPath}`,
    );
  }

  let schema: FormSchema;
  let bytes: Buffer;

  try {
    ({ schema, bytes } = await readFormSchemaDocWithBytes(
      installedPath,
      schemaPath,
    ));
  } catch (err) {
    // The reader throws CONFIG (it serves the manifest-load path too); at
    // install the right taxonomy is FLOW_INSTALL, and the profile name is the
    // context the operator needs.
    throw new MaisterError(
      "FLOW_INSTALL",
      `result_profiles.${name}: ${(err as Error).message}`,
      { cause: err as Error },
    );
  }

  if (
    schemaDocUsesCoordinatorGrammar(schema) &&
    !semverGte(engineMin, OUTPUT_COORDINATOR_ENGINE_MIN)
  ) {
    throw new MaisterError(
      "FLOW_INSTALL",
      `result_profiles.${name} schema ${schemaPath} uses the json field type or typed array items but engine_min "${engineMin}" < ${OUTPUT_COORDINATOR_ENGINE_MIN} — bump compat.engine_min to ${OUTPUT_COORDINATOR_ENGINE_MIN}`,
    );
  }

  return {
    schemaPath,
    schemaStem: schemaStemOf(schemaPath),
    schemaVersion: schema.schemaVersion,
    // Hash the document's EXACT bytes, so a schema edited under a stable
    // package ref is detectable from a persisted result row after the fact.
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    schema,
  };
}

/**
 * Resolve a package's whole `result_profiles` block, or `null` when it declares
 * none. `null` is the persisted "this package has no profiles" value — the
 * sparse map stays sparse (a per-key default would destroy the "was this
 * declared?" signal).
 */
export async function resolveResultProfiles(args: {
  readonly installedPath: string;
  readonly declared: DeclaredResultProfiles | undefined;
  readonly engineMin: string;
}): Promise<ResultProfileMap | null> {
  const entries = Object.entries(args.declared ?? {});

  if (entries.length === 0) return null;

  const resolved: ResultProfileMap = {};

  for (const [name, entry] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    resolved[name] = await resolveProfileDoc({
      installedPath: args.installedPath,
      name,
      schemaPath: entry.schema,
      engineMin: args.engineMin,
    });
  }

  return resolved;
}
