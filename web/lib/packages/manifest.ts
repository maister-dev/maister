import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";
import { parse as parseYaml } from "yaml";

import {
  maisterPackageManifestSchema,
  type MaisterPackageManifest,
} from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";
import { envRefName } from "@/lib/mcp/value-grammar";

const log = pino({
  name: "package-manifest",
  level: process.env.LOG_LEVEL ?? "info",
});

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const PACKAGE_MANIFEST_FILENAME = "maister-package.yaml";

// ADR-177 (D34): the loader is the ONLY place that knows the legacy list form.
// `attach.ts` and Studio consume this type and see `mcps[].env` as a map,
// always. The zod schema keeps the union so its output type stays honest about
// what a FILE may contain; normalization happens once, here.
export type NormalizedPackageManifest = Omit<MaisterPackageManifest, "mcps"> & {
  mcps: (Omit<MaisterPackageManifest["mcps"][number], "env"> & {
    env?: Record<string, string>;
  })[];
};

function normalizeMcpEnv(
  env: string[] | Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  if (!Array.isArray(env)) return env;

  // A legacy entry is `env:NAME`; the declared SLOT is the bare name and the
  // declared VALUE is the reference itself.
  return Object.fromEntries(
    env.map((ref) => [envRefName(ref) ?? ref, ref] as const),
  );
}

export function normalizePackageManifest(
  manifest: MaisterPackageManifest,
): NormalizedPackageManifest {
  return {
    ...manifest,
    mcps: manifest.mcps.map((mcp) => {
      const env = normalizeMcpEnv(mcp.env);

      return env === undefined ? { ...mcp, env: undefined } : { ...mcp, env };
    }),
  };
}

// Loads + validates `<packageRoot>/maister-package.yaml` (ADR-088). Every
// failure mode is CONFIG so callers branch on one code; the package
// installer adds its own FLOW_INSTALL wrapping for fetch/copy failures.
export async function loadMaisterPackageManifest(
  packageRoot: string,
): Promise<NormalizedPackageManifest> {
  const manifestPath = join(packageRoot, PACKAGE_MANIFEST_FILENAME);
  let raw: string;

  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Cannot read ${PACKAGE_MANIFEST_FILENAME} at ${manifestPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `Invalid YAML in ${manifestPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }

  const parsed = maisterPackageManifestSchema.safeParse(data);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");

    log.warn(
      { path: manifestPath, issues },
      "maister-package.yaml validation failed",
    );
    throw new MaisterError(
      "CONFIG",
      `${PACKAGE_MANIFEST_FILENAME} invalid at ${manifestPath}: ${issues}`,
    );
  }

  log.debug(
    {
      path: manifestPath,
      name: parsed.data.name,
      flows: parsed.data.flows.length,
      capabilities: parsed.data.capabilities.length,
      mcps: parsed.data.mcps.length,
      restrictions: parsed.data.restrictions.length,
      evaluationMethods: parsed.data.evaluationMethods.length,
    },
    "maister-package.yaml loaded",
  );

  return normalizePackageManifest(parsed.data);
}
