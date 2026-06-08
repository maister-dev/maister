import { pathToFileURL } from "node:url";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getAuthoredCapability } from "@/lib/catalog/authored-service";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  authoredFlowPackageBodyFromUnknown,
  validateAuthoredFlowPackageBody,
  writeAuthoredFlowPackageDirectory,
} from "@/lib/flows/package-authoring";

const log = pino({
  name: "export-authored-flow",
  level: process.env.LOG_LEVEL ?? "info",
});

type QueryResult = {
  rows?: unknown[];
};

type ScriptDb = {
  execute(query: SQL): Promise<QueryResult>;
};

type CapabilityIdRow = {
  id: string;
};

export type ExportAuthoredFlowArgs = {
  project: string;
  outputDir: string;
  capId?: string;
  slug?: string;
};

export function parseExportAuthoredFlowArgs(
  argv: readonly string[],
): ExportAuthoredFlowArgs {
  const flags = parseFlagPairs(
    argv,
    "--project <slug> (--cap-id <id> | --slug <package-slug>) --output-dir <path>",
  );

  if (!flags.project) {
    throw new MaisterError("CONFIG", "Missing required --project");
  }
  if (!flags["output-dir"]) {
    throw new MaisterError("CONFIG", "Missing required --output-dir");
  }
  if (Boolean(flags["cap-id"]) === Boolean(flags.slug)) {
    throw new MaisterError(
      "CONFIG",
      "Provide exactly one of --cap-id or --slug",
    );
  }

  return {
    project: flags.project,
    outputDir: flags["output-dir"],
    capId: flags["cap-id"],
    slug: flags.slug,
  };
}

async function main(): Promise<void> {
  await import("@/lib/load-env");

  const args = parseExportAuthoredFlowArgs(process.argv.slice(2));
  const db = getDb() as unknown as ScriptDb;
  const capId =
    args.capId ??
    (await resolveAuthoredFlowCapabilityId(db, args.project, args.slug));

  log.info(
    {
      projectSlug: args.project,
      capId,
      packageSlug: args.slug,
      outputDir: args.outputDir,
    },
    "authored Flow package export start",
  );

  const detail = await getAuthoredCapability({
    projectSlug: args.project,
    capId,
    db,
  });
  const revision = detail.draft ?? detail.published;

  if (!revision) {
    throw new MaisterError(
      "CONFLICT",
      `authored Flow ${capId} has no draft or published revision to export`,
    );
  }

  const packageBody = validateAuthoredFlowPackageBody(
    authoredFlowPackageBodyFromUnknown({
      value: revision.body,
      fallbackMetadata: {
        slug: detail.capability.slug,
        name: detail.capability.title,
      },
      context: `${args.project}/${capId} export`,
    }),
  );

  if (packageBody.validation.status !== "valid") {
    throw new MaisterError(
      "CONFIG",
      `cannot export invalid authored Flow package ${packageBody.packageMetadata.slug}: ${packageBody.validation.issueCount} issue(s)`,
    );
  }

  await writeAuthoredFlowPackageDirectory(packageBody, args.outputDir);

  log.info(
    {
      projectSlug: args.project,
      capId,
      packageSlug: packageBody.packageMetadata.slug,
      outputDir: args.outputDir,
      fileCount: packageBody.files.length + 1,
      manifestDigest: packageBody.validation.manifestDigest,
      contentHash: packageBody.validation.contentHash,
    },
    "authored Flow package export complete",
  );
}

async function resolveAuthoredFlowCapabilityId(
  db: ScriptDb,
  projectSlug: string,
  slug: string | undefined,
): Promise<string> {
  if (!slug) {
    throw new MaisterError("CONFIG", "Missing authored Flow --slug");
  }

  const result = await db.execute(sql`
    SELECT ac.id
    FROM authored_capabilities ac
    JOIN projects p ON p.id = ac.project_id
    WHERE p.slug = ${projectSlug}
      AND ac.kind = 'flow'
      AND ac.slug = ${slug}
      AND ac.lifecycle <> 'ARCHIVED'
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as CapabilityIdRow | undefined;

  if (!row) {
    throw new MaisterError(
      "CONFIG",
      `authored Flow not found for ${projectSlug}/${slug}`,
    );
  }

  return row.id;
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
          "export-authored-flow failed",
        );
      } else {
        log.error({ err }, "export-authored-flow failed (unexpected)");
      }
      await flushLogger();
      process.exit(1);
    });
}
