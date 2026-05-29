import "@/lib/load-env";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { installFlowPlugin } from "@/lib/flows";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "install-flow",
  level: process.env.LOG_LEVEL ?? "info",
});

type CliArgs = {
  project: string;
  source: string;
  version: string;
  flowId: string;
  workspaceRoot?: string;
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
        `Bad argv near "${flag}". Usage: --project <slug> --source <url> --version <tag> --flow-id <id> [--workspace-root <path>]`,
      );
    }

    out[flag.slice(2)] = value;
  }

  for (const required of ["project", "source", "version", "flow-id"]) {
    if (!out[required]) {
      throw new MaisterError("CONFIG", `Missing required --${required}`);
    }
  }

  return {
    project: out.project,
    source: out.source,
    version: out.version,
    flowId: out["flow-id"],
    workspaceRoot: out["workspace-root"],
  };
}

async function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    log.flush();
    setImmediate(resolve);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // FIXME(any): dual drizzle-orm peer-dep variants; see seed.ts.
  const db = getDb() as unknown as {
    select: () => {
      from: (t: unknown) => {
        where: (clause: unknown) => Promise<Array<Record<string, any>>>;
      };
    };
  };

  log.info({ project: args.project, flowId: args.flowId }, "lookup project row");
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

  log.info(
    { project: project.slug, projectId: project.id, repoPath: project.repoPath },
    "project found",
  );

  const result = await installFlowPlugin({
    source: args.source,
    version: args.version,
    projectId: project.id,
    projectSlug: project.slug,
    flowId: args.flowId,
    workspaceRoot: args.workspaceRoot ?? project.repoPath,
    db,
  });

  log.info(
    {
      flowRowId: result.flowRowId,
      revisionId: result.revisionId,
      revision: result.revision,
      installedPath: result.installedPath,
      symlinkPath: result.symlinkPath,
      trustStatus: result.trustStatus,
      enablementState: result.enablementState,
    },
    "install-flow done",
  );
}

main()
  .then(async () => {
    await flushLogger();
    process.exit(0);
  })
  .catch(async (err) => {
    if (isMaisterError(err)) {
      log.error(
        { code: err.code, message: err.message, cause: (err.cause as Error)?.message },
        "install-flow failed",
      );
    } else {
      log.error({ err }, "install-flow failed (unexpected)");
    }
    await flushLogger();
    process.exit(1);
  });
