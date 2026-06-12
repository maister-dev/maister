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

const log = pino({
  name: "package-manifest",
  level: process.env.LOG_LEVEL ?? "info",
});

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const PACKAGE_MANIFEST_FILENAME = "maister-package.yaml";

// Loads + validates `<packageRoot>/maister-package.yaml` (ADR-088). Every
// failure mode is CONFIG so callers branch on one code; the package
// installer adds its own FLOW_INSTALL wrapping for fetch/copy failures.
export async function loadMaisterPackageManifest(
  packageRoot: string,
): Promise<MaisterPackageManifest> {
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
    },
    "maister-package.yaml loaded",
  );

  return parsed.data;
}
