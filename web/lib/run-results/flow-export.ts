import type { FindingsContract } from "./findings-contract";
import type { RunResultContract } from "@/lib/run-results/types";

import { createHash } from "node:crypto";

import {
  findingsContractSchema,
  FINDINGS_ENGINE_MIN,
} from "./findings-contract";

import { semverGte } from "@/lib/flows/semver";
import { readFormSchemaDocWithBytes } from "@/lib/config";
import { MaisterError } from "@/lib/errors";
import { buildFlowExportContract } from "@/lib/run-results/contract";

// ADR-165 (T4.1): ONE resolver for a flow's `result.export`, shared by the
// canonical launcher (where it is DECISIVE — it writes `runs.result_contract`)
// and by `resolveDelegatableFlow`'s pre-flight (where it only fails fast, so a
// delegation with a broken export never mints a carrier task). Two copies would
// let the pre-flight pass while the launch refused, which is the shape that
// leaves an orphaned carrier task behind.

/** The revision fields the resolver needs. Kept structural so tests can pass a literal. */
export type ExportRevisionRef = {
  id: string;
  resolvedRevision: string;
  installedPath: string;
};

/**
 * The manifest is taken as `unknown` and narrowed here on purpose. The two
 * callers hold `FlowYamlV1` values produced by DIFFERENT zod peer-dep instances
 * (TypeScript treats them as unrelated), and the schema is `.passthrough()`, so
 * `result` is typed `unknown` on the way in regardless. Narrowing at the one
 * place that reads the key beats a cast at every call site.
 */
export function declaredResultExport(manifest: unknown): {
  schema: string;
  from: string[];
  required: boolean;
  nativeContract?: FindingsContract;
} | null {
  const block = (manifest as { result?: unknown } | null)?.result;
  const declared =
    block && typeof block === "object"
      ? ((block as { export?: unknown }).export as
          | {
              schema?: unknown;
              from?: unknown;
              required?: unknown;
              native_contract?: unknown;
            }
          | undefined)
      : undefined;

  if (
    !declared ||
    typeof declared.schema !== "string" ||
    !Array.isArray(declared.from)
  ) {
    return null;
  }

  const native = findingsContractSchema
    .optional()
    .safeParse(declared.native_contract);

  if (!native.success)
    throw new MaisterError(
      "CONFIG",
      "Pinned result export selects an unsupported native contract",
    );
  if (native.data !== undefined) {
    const engineMin = (manifest as { compat?: { engine_min?: unknown } }).compat
      ?.engine_min;

    if (
      typeof engineMin !== "string" ||
      !semverGte(engineMin, FINDINGS_ENGINE_MIN)
    )
      throw new MaisterError(
        "CONFIG",
        `Native result exports require compat.engine_min >= ${FINDINGS_ENGINE_MIN}`,
      );
  }

  return {
    schema: declared.schema,
    ...(native.data === undefined ? {} : { nativeContract: native.data }),
    from: declared.from as string[],
    // The Zod default already fills this, but a manifest read straight from a
    // stored jsonb column bypasses the parse — default here too rather than
    // treat a missing flag as "optional", which is the fail-OPEN direction.
    required:
      declared.required === undefined ? true : declared.required === true,
  };
}

/**
 * Resolve the export schema from the PINNED revision's install dir and build the
 * run contract, or return `null` when the flow declares no export.
 *
 * Throws `CONFIG` when the declared document cannot be read or does not parse.
 * The caller runs this BEFORE any irreversible side-effect, so the refusal
 * leaves nothing behind.
 */
export async function resolveFlowExportContract(args: {
  flowRefId: string;
  manifest: unknown;
  revision: ExportRevisionRef;
}): Promise<RunResultContract | null> {
  const declared = declaredResultExport(args.manifest);

  if (!declared) return null;

  let schema;
  let bytes;

  try {
    ({ schema, bytes } = await readFormSchemaDocWithBytes(
      args.revision.installedPath,
      declared.schema,
    ));
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `flow ${args.flowRefId} declares result.export.schema "${declared.schema}" but it cannot be resolved from the pinned revision: ${(err as Error).message}`,
      { cause: err as Error },
    );
  }

  return buildFlowExportContract({
    flowRefId: args.flowRefId,
    resolvedRevision: args.revision.resolvedRevision,
    flowRevisionId: args.revision.id,
    schemaPath: declared.schema,
    nativeContract: declared.nativeContract,
    schema,
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    required: declared.required,
    producerNodeIds: declared.from,
  });
}
