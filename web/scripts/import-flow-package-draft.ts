import { pathToFileURL } from "node:url";

import pino from "pino";

import { createAuthoredCapability } from "@/lib/catalog/authored-service";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  createAuthoredFlowPackageBody,
  parseAuthoredFlowPackageSlug,
  readAuthoredFlowPackageDirectory,
  validateAuthoredFlowPackageBody,
} from "@/lib/flows/package-authoring";

const log = pino({
  name: "import-flow-package-draft",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ImportFlowPackageDraftArgs = {
  project: string;
  sourceDir: string;
  slug?: string;
  title?: string;
};

export function parseImportFlowPackageDraftArgs(
  argv: readonly string[],
): ImportFlowPackageDraftArgs {
  const flags = parseFlagPairs(
    argv,
    "--project <slug> [--source-dir <path>] [--slug <package-slug>] [--title <title>]",
  );

  if (!flags.project) {
    throw new MaisterError("CONFIG", "Missing required --project");
  }

  return {
    project: flags.project,
    sourceDir: flags["source-dir"] ?? "../plugins/aif",
    slug:
      flags.slug === undefined
        ? undefined
        : parseAuthoredFlowPackageSlug(
            flags.slug,
            "import-flow-package-draft --slug",
          ),
    title: flags.title,
  };
}

async function main(): Promise<void> {
  await import("@/lib/load-env");

  const args = parseImportFlowPackageDraftArgs(process.argv.slice(2));

  log.info(
    { projectSlug: args.project, sourceDir: args.sourceDir },
    "authored Flow package import start",
  );

  const imported = await readAuthoredFlowPackageDirectory(args.sourceDir);
  const packageBody = validateAuthoredFlowPackageBody(
    createAuthoredFlowPackageBody({
      flowYaml: imported.flowYaml,
      packageMetadata: {
        ...imported.packageMetadata,
        slug: args.slug ?? imported.packageMetadata.slug,
        name: args.title ?? imported.packageMetadata.name,
      },
      files: imported.files,
    }),
  );

  if (packageBody.validation.status !== "valid") {
    throw new MaisterError(
      "CONFIG",
      `cannot import invalid authored Flow package ${packageBody.packageMetadata.slug}: ${packageBody.validation.issueCount} issue(s)`,
    );
  }

  const result = await createAuthoredCapability({
    projectSlug: args.project,
    input: {
      kind: "flow",
      slug: packageBody.packageMetadata.slug,
      title: packageBody.packageMetadata.name,
      body: packageBody,
      manifest: packageBody.manifest,
      schemaVersion: 1,
    },
  });

  log.info(
    {
      projectSlug: args.project,
      sourceDir: args.sourceDir,
      packageSlug: packageBody.packageMetadata.slug,
      capabilityId: result.capability.id,
      draftRevisionId: result.draft.id,
      fileCount: packageBody.files.length,
      validationStatus: packageBody.validation.status,
    },
    "authored Flow package import complete",
  );
}

function parseFlagPairs(
  argv: readonly string[],
  usage: string,
): Record<string, string> {
  const flags: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new MaisterError(
        "CONFIG",
        `Bad argv near "${flag}". Usage: ${usage}`,
      );
    }

    flags[flag.slice(2)] = value;
  }

  return flags;
}

function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    log.flush();
    setImmediate(resolve);
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];

  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  main()
    .then(async () => {
      await flushLogger();
      process.exit(0);
    })
    .catch(async (err) => {
      if (isMaisterError(err)) {
        log.error(
          { code: err.code, message: err.message },
          "import-flow-package-draft failed",
        );
      } else {
        log.error({ err }, "import-flow-package-draft failed (unexpected)");
      }
      await flushLogger();
      process.exit(1);
    });
}
