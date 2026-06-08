import { pathToFileURL } from "node:url";

import pino from "pino";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { readAuthoredFlowPackageDirectory } from "@/lib/flows/package-authoring";

const log = pino({
  name: "validate-authored-flow",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ValidateAuthoredFlowArgs = {
  sourceDir: string;
};

export function parseValidateAuthoredFlowArgs(
  argv: readonly string[],
): ValidateAuthoredFlowArgs {
  const flags = parseFlagPairs(argv, ["--source-dir <path>"].join(" "));

  return {
    sourceDir: flags["source-dir"] ?? "../plugins/aif",
  };
}

async function main(): Promise<void> {
  await import("@/lib/load-env");

  const args = parseValidateAuthoredFlowArgs(process.argv.slice(2));

  log.info(
    { sourceDir: args.sourceDir },
    "authored Flow package validation start",
  );
  const body = await readAuthoredFlowPackageDirectory(args.sourceDir);

  log.info(
    {
      sourceDir: args.sourceDir,
      packageSlug: body.packageMetadata.slug,
      validationStatus: body.validation.status,
      issueCount: body.validation.issueCount,
      fileCount: body.files.length,
      manifestDigest: body.validation.manifestDigest,
      contentHash: body.validation.contentHash,
    },
    "authored Flow package validation complete",
  );

  if (body.validation.status !== "valid") {
    throw new MaisterError(
      "CONFIG",
      `authored Flow package ${body.packageMetadata.slug} is invalid: ${body.validation.issueCount} issue(s)`,
    );
  }
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
          "validate-authored-flow failed",
        );
      } else {
        log.error({ err }, "validate-authored-flow failed (unexpected)");
      }
      await flushLogger();
      process.exit(1);
    });
}
