import { join } from "node:path";

import pino from "pino";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { loadFlowManifest } from "@/lib/config";
import { loadMaisterPackageManifest } from "@/lib/packages/manifest";
import {
  checkMethodEngineCompatibility,
  loadEvaluationMethod,
} from "@/lib/evaluations/method";
import { MAISTER_ENGINE_VERSION } from "@/lib/flows/engine-version";

const log = pino({
  name: "validate-package-compatibility",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ValidatePackageArgs = {
  mode: string;
  source: string;
  tag: string;
};

export type ValidatePackageResult = {
  packageName: string;
  version: string;
  flowCount: number;
  evaluationMethodCount: number;
};

// Parse the release wrapper argv: `--mode release --source <repo> --tag <name>/<v>`.
export function parseValidatePackageArgs(
  argv: readonly string[],
): ValidatePackageArgs {
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    // A bare `--` is the package-manager argument separator; ignore it.
    if (token === "--") continue;

    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];

      if (next === undefined || next.startsWith("--")) {
        throw new MaisterError("CONFIG", `Flag ${token} requires a value`);
      }
      flags[key] = next;
      i++;
    }
  }

  const source = flags.source;
  const tag = flags.tag;

  if (!source) {
    throw new MaisterError("CONFIG", "Missing required --source <repo root>");
  }
  if (!tag || !tag.includes("/")) {
    throw new MaisterError(
      "CONFIG",
      "Missing/invalid --tag (expected <package>/<version>)",
    );
  }

  return { mode: flags.mode ?? "ci", source, tag };
}

// Static + engine-compatibility validation of one package's tagged bytes WITHOUT
// executing any package content (no setup.sh, no prompt/check/aggregation run;
// ADR-143 D7). Validates the manifest, every flow.yaml, and every Evaluation
// Method (schema + referenced prompt/schema assets + normalization + engine
// range). Throws MaisterError on the first failure; returns counts on success.
export async function validatePackageCompatibility(
  args: ValidatePackageArgs,
): Promise<ValidatePackageResult> {
  const [packageName, version] = args.tag.split("/", 2);
  const packageRoot = join(args.source, "packages", packageName);

  log.info(
    { packageName, version, packageRoot, engine: MAISTER_ENGINE_VERSION },
    "package compatibility gate start",
  );

  const manifest = await loadMaisterPackageManifest(packageRoot);

  if (manifest.name !== packageName) {
    throw new MaisterError(
      "CONFIG",
      `manifest name "${manifest.name}" does not match tag package "${packageName}"`,
    );
  }

  for (const flow of manifest.flows) {
    const flowYamlPath = join(packageRoot, flow.path, "flow.yaml");

    await loadFlowManifest(flowYamlPath, {
      errorCode: "FLOW_INSTALL",
      surface: "package-release-gate",
    });
    log.info({ packageName, flowId: flow.id }, "flow manifest compatible");
  }

  for (const method of manifest.evaluationMethods) {
    const methodRoot = join(packageRoot, method.path);
    const loaded = await loadEvaluationMethod(methodRoot);
    const compat = checkMethodEngineCompatibility(loaded.definition);

    if (!compat.compatible) {
      throw new MaisterError(
        "CONFIG",
        `evaluation method ${method.id} is incompatible: ${compat.reason}`,
      );
    }
    log.info(
      {
        packageName,
        methodId: method.id,
        contentDigest: loaded.contentDigest,
        aggregation: loaded.definition.aggregation.algorithm,
      },
      "evaluation method compatible",
    );
  }

  log.info(
    {
      packageName,
      version,
      flows: manifest.flows.length,
      evaluationMethods: manifest.evaluationMethods.length,
    },
    "package compatibility gate passed",
  );

  return {
    packageName,
    version,
    flowCount: manifest.flows.length,
    evaluationMethodCount: manifest.evaluationMethods.length,
  };
}

async function main(): Promise<void> {
  const args = parseValidatePackageArgs(process.argv.slice(2));

  try {
    await validatePackageCompatibility(args);
    process.exitCode = 0;
  } catch (err) {
    if (isMaisterError(err)) {
      log.error({ code: err.code, reason: err.message }, "package gate failed");
    } else {
      log.error(
        { reason: err instanceof Error ? err.message : String(err) },
        "package gate failed (unexpected)",
      );
    }
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("validate-package-compatibility.ts") ?? false;

if (isDirectRun) {
  void main();
}
