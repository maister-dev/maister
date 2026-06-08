import { pathToFileURL } from "node:url";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { installAuthoredFlowPackageBridge } from "@/lib/flows";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "install-authored-flow-package",
  level: process.env.LOG_LEVEL ?? "info",
});

type ProjectRow = {
  id: string;
  slug: string;
  repoPath: string;
};

export type InstallAuthoredFlowPackageArgs = {
  project: string;
  sourceDir: string;
  version: string;
  flowId: string;
  workspaceRoot?: string;
};

export function parseInstallAuthoredFlowPackageArgs(
  argv: readonly string[],
): InstallAuthoredFlowPackageArgs {
  const flags = parseFlagPairs(
    argv,
    "--project <slug> --source-dir <path> --version <label> --flow-id <id> [--workspace-root <path>]",
  );

  for (const required of ["project", "source-dir", "version", "flow-id"]) {
    if (!flags[required]) {
      throw new MaisterError("CONFIG", `Missing required --${required}`);
    }
  }

  return {
    project: flags.project,
    sourceDir: flags["source-dir"],
    version: flags.version,
    flowId: flags["flow-id"],
    workspaceRoot: flags["workspace-root"],
  };
}

async function main(): Promise<void> {
  await import("@/lib/load-env");

  const args = parseInstallAuthoredFlowPackageArgs(process.argv.slice(2));
  const db = getDb() as unknown as {
    select: () => {
      from: (t: unknown) => {
        where: (clause: unknown) => Promise<ProjectRow[]>;
      };
    };
  };

  log.info(
    {
      projectSlug: args.project,
      sourceDir: args.sourceDir,
      flowId: args.flowId,
      version: args.version,
    },
    "authored Flow package bridge install start",
  );

  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, args.project));
  const project = rows[0];

  if (!project) {
    throw new MaisterError(
      "PRECONDITION",
      `project "${args.project}" not registered. Seed it first or register it in the project UI.`,
    );
  }

  const result = await installAuthoredFlowPackageBridge({
    source: args.sourceDir,
    version: args.version,
    projectId: project.id,
    projectSlug: project.slug,
    flowId: args.flowId,
    workspaceRoot: args.workspaceRoot ?? project.repoPath,
    db,
  });

  log.info(
    {
      projectSlug: project.slug,
      flowRowId: result.flowRowId,
      revisionId: result.revisionId,
      revision: result.revision,
      installedPath: result.installedPath,
      trustStatus: result.trustStatus,
      enablementState: result.enablementState,
    },
    "authored Flow package bridge install complete",
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
          "install-authored-flow-package failed",
        );
      } else {
        log.error({ err }, "install-authored-flow-package failed (unexpected)");
      }
      await flushLogger();
      process.exit(1);
    });
}
