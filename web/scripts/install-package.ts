import "@/lib/load-env";

import { eq } from "drizzle-orm";
import pino from "pino";

import { installAndIngestCapabilityImports } from "@/lib/capabilities/import";
import { loadProjectConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { installPackage } from "@/lib/packages/install";

// FIXME(any): dual drizzle-orm peer-dep variants (see install-flow.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "install-package",
  level: process.env.LOG_LEVEL ?? "info",
});

type CliArgs = {
  project: string;
  source: string;
  version: string;
  path?: string;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const out: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new MaisterError(
        "CONFIG",
        `Bad argv near "${flag}". Usage: --project <slug> --source <url|dir> --version <tag> [--path <subdir>]`,
      );
    }

    out[flag.slice(2)] = value;
  }

  for (const required of ["project", "source", "version"]) {
    if (!out[required]) {
      throw new MaisterError("CONFIG", `Missing required --${required}`);
    }
  }

  return {
    project: out.project,
    source: out.source,
    version: out.version,
    path: out.path,
  };
}

async function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    log.flush();
    setImmediate(resolve);
  });
}

// Ops smoke CLI for ADR-087 package installs: installs every flow + bundle a
// package ships into a registered project, then ingests the package-derived
// capability entries through the project's SET/CLEAR upsert (re-reading the
// project's maister.yaml so config + import + package records stay one
// symmetric write).
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // FIXME(any): dual drizzle-orm peer-dep variants; see install-flow.ts.
  const db = getDb() as any;

  log.info({ project: args.project, source: args.source }, "lookup project row");
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, args.project));

  if (rows.length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `project "${args.project}" not registered. Seed it first (pnpm db:seed) or via the project registry API.`,
    );
  }

  const project = rows[0];

  const result = await installPackage({
    source: args.source,
    version: args.version,
    path: args.path,
    projectId: project.id,
    projectSlug: project.slug,
    workspaceRoot: project.repoPath,
    db,
  });

  const config = await loadProjectConfig(project.maisterYamlPath);

  await installAndIngestCapabilityImports({
    config,
    projectId: project.id,
    additionalImportDerived: result.capabilityDerived,
    db,
  });

  log.info(
    {
      package: result.name,
      revision: result.resolvedRevision,
      versionLabel: result.versionLabel,
      flows: result.flows.map((f) => ({
        flowRowId: f.flowRowId,
        revisionId: f.revisionId,
      })),
      capabilities: result.capabilityDerived.map((c) => c.id),
    },
    "install-package done",
  );
}

main()
  .then(async () => {
    await flushLogger();
    process.exit(0);
  })
  .catch(async (err) => {
    if (isMaisterError(err)) {
      log.error({ code: err.code, message: err.message }, "install-package failed");
    } else {
      log.error({ err: (err as Error).message }, "install-package failed");
    }
    await flushLogger();
    process.exit(1);
  });
