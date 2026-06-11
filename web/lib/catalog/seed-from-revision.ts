import "server-only";

import type { AuthoredCapabilityBody } from "@/lib/catalog/authored-types";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { createAuthoredCapability } from "@/lib/catalog/authored-service";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { readAuthoredFlowPackageDirectory } from "@/lib/flows/package-authoring";
import { getFlowPackageDetail } from "@/lib/queries/flow-packages";

const log = pino({
  name: "flow-fork",
  level: process.env.LOG_LEVEL ?? "info",
});

const MAX_FORK_SLUG_PROBES = 256;

type ProbeDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

export type SeedAuthoredDraftFromRevisionArgs = {
  projectSlug: string;
  flowRefId: string;
  revisionId: string;
  slug?: string;
  title?: string;
};

export type SeedAuthoredDraftResult = {
  capId: string;
  projectSlug: string;
  slug: string;
};

/**
 * Pick the slug for a forked authored `flow` draft. An EXPLICIT slug that
 * collides throws CONFLICT (no probe — the caller asked for a specific name).
 * The implicit default probes `slug`, `slug-fork`, `slug-fork-2`, … until a
 * free slug is found.
 */
export async function resolveForkSlug(args: {
  explicitSlug?: string;
  defaultSlug: string;
  slugExists: (slug: string) => Promise<boolean>;
}): Promise<string> {
  if (args.explicitSlug !== undefined) {
    if (await args.slugExists(args.explicitSlug)) {
      throw new MaisterError(
        "CONFLICT",
        `authored flow slug "${args.explicitSlug}" already exists`,
      );
    }

    return args.explicitSlug;
  }

  if (!(await args.slugExists(args.defaultSlug))) return args.defaultSlug;

  for (let n = 1; n <= MAX_FORK_SLUG_PROBES; n += 1) {
    const candidate =
      n === 1 ? `${args.defaultSlug}-fork` : `${args.defaultSlug}-fork-${n}`;

    if (!(await args.slugExists(candidate))) return candidate;
  }

  throw new MaisterError(
    "CONFLICT",
    `could not find a free fork slug for "${args.defaultSlug}"`,
  );
}

/**
 * T2.2 — fork an INSTALLED (immutable) flow revision into an authored `flow`
 * draft. All reads precede the single transactional write
 * (`createAuthoredCapability`). The installed bundle is read as TEXT only —
 * nothing in it is executed and `exec_trust` is never flipped.
 *
 * Errors: foreign/unknown flow or revision → PRECONDITION (route → 404);
 * missing/unreadable bundle dir → CONFIG (422); explicit colliding slug →
 * CONFLICT (409).
 */
export async function seedAuthoredDraftFromRevision(
  args: SeedAuthoredDraftFromRevisionArgs,
): Promise<SeedAuthoredDraftResult> {
  const detail = await getFlowPackageDetail(args.projectSlug, args.flowRefId);

  if (!detail) {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${args.flowRefId}" is not configured for project ${args.projectSlug}`,
    );
  }

  const revision = detail.revisions.find((r) => r.id === args.revisionId);

  if (!revision) {
    throw new MaisterError(
      "PRECONDITION",
      `revision "${args.revisionId}" does not belong to flow "${args.flowRefId}"`,
    );
  }

  const body = await readForkBundle(revision.installedPath, {
    flowRefId: args.flowRefId,
    revisionId: args.revisionId,
  });

  const slug = await resolveForkSlug({
    explicitSlug: args.slug,
    defaultSlug: args.flowRefId,
    slugExists: (candidate) =>
      authoredFlowSlugExists(detail.project.id, candidate),
  });

  const title = args.title ?? body.packageMetadata.name ?? slug;

  const result = await createAuthoredCapability({
    projectSlug: args.projectSlug,
    input: {
      kind: "flow",
      slug,
      title,
      body: body as unknown as AuthoredCapabilityBody,
      manifest: body.manifest,
      sourceFlowRefId: detail.flow.flowRefId,
    },
  });

  log.info(
    {
      capId: result.capability.id,
      flowRefId: detail.flow.flowRefId,
      revisionId: args.revisionId,
      slug,
      projectId: detail.project.id,
    },
    "authored flow draft forked from installed revision",
  );

  return {
    capId: result.capability.id,
    projectSlug: detail.project.slug,
    slug,
  };
}

async function readForkBundle(
  installedPath: string,
  context: { flowRefId: string; revisionId: string },
) {
  try {
    return await readAuthoredFlowPackageDirectory(installedPath);
  } catch (err) {
    log.warn(
      {
        flowRefId: context.flowRefId,
        revisionId: context.revisionId,
        reason: "bundle-missing",
      },
      "installed flow bundle is missing or unreadable on disk",
    );

    // Always re-wrap with a sanitized message. `readAuthoredFlowPackageDirectory`
    // embeds the absolute `installedPath` in its own CONFIG messages; re-throwing
    // it verbatim would leak that server-only path into the 422 response body
    // (catalogErrorResponse serializes `message`). The original stays in `cause`
    // for server-side logs only (never serialized to the client).
    throw new MaisterError(
      "CONFIG",
      `installed flow bundle for "${context.flowRefId}" is missing or unreadable on disk`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

async function authoredFlowSlugExists(
  projectId: string,
  slug: string,
): Promise<boolean> {
  const db = getDb() as unknown as ProbeDb;
  const result = await db.execute(sql`
    SELECT 1
    FROM authored_capabilities
    WHERE project_id = ${projectId}
      AND kind = 'flow'
      AND slug = ${slug}
    LIMIT 1
  `);

  return (result.rows ?? []).length > 0;
}
