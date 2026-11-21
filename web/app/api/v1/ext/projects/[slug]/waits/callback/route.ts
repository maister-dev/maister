import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { normalizePublicationOrigin } from "../../../../../../../../../runtime/workspace-publication";

import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import {
  projectTokens,
  projects,
  runPublications,
  runWaits,
} from "@/lib/db/schema";
import { handleExt } from "@/lib/tokens/ext-handler";
import { projectWaitSignalGrant } from "@/lib/waits/authority";

const endpoint = "/api/v1/ext/projects/{slug}/waits/callback";
const query = z.strictObject({
  signal: z.string().min(1).max(128),
  ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9_][A-Za-z0-9._/-]{0,250}$/),
  headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  providerExecutionId: z.string().min(1).max(256).optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  const db = getDb();

  return handleExt(
    request,
    { slug, db, scopeLabel: "waits:signal", endpoint, method: "GET" },
    async ({ actor, projectId }) => {
      if (actor.tokenKind !== "project")
        return privateJson(
          { code: "UNAUTHORIZED", message: "Project token required" },
          403,
        );
      const parameters = new URL(request.url).searchParams;
      const fields = [...parameters.keys()];
      const parsed = query.safeParse(Object.fromEntries(parameters));

      if (!parsed.success || new Set(fields).size !== fields.length)
        return privateJson(
          { code: "CONFIG", message: "Invalid wait callback query" },
          422,
        );
      const { signal, ref, headSha } = parsed.data;
      const [authority] = await db
        .select({ repoUrl: projects.repoUrl })
        .from(projects)
        .innerJoin(
          projectTokens,
          projectWaitSignalGrant(projectId, actor.tokenId),
        )
        .where(
          and(eq(projects.id, projectId), sql`${projects.archivedAt} IS NULL`),
        );

      if (!authority)
        return privateJson(
          {
            code: "UNAUTHORIZED",
            message: "Current project signal grant required",
          },
          403,
        );
      const repoIdentity =
        authority.repoUrl && normalizePublicationOrigin(authority.repoUrl);

      if (!repoIdentity)
        return privateJson(
          { code: "NOT_FOUND", message: "Wait callback not found" },
          404,
        );
      const matches = await db
        .select({
          runId: runWaits.runId,
          waitId: runWaits.id,
          state: runWaits.state,
          expired: sql<boolean>`coalesce(${runWaits.state}='reserved' AND ${runWaits.reservedUntil} <= clock_timestamp(), false)`,
        })
        .from(runWaits)
        .innerJoin(
          runPublications,
          and(
            eq(runPublications.id, runWaits.publicationId),
            eq(runPublications.projectId, runWaits.projectId),
          ),
        )
        .where(
          and(
            eq(runWaits.projectId, projectId),
            eq(runWaits.conditionKind, "ci"),
            eq(runPublications.headRef, ref),
            eq(runPublications.repoIdentity, repoIdentity),
            eq(runPublications.sourceHead, headSha),
            sql`${runWaits.condition}->'parameters'->>'transport' = 'push'`,
            sql`${runWaits.condition}->'parameters'->>'name' = ${signal}`,
            sql`${runWaits.condition}->'parameters'->>'issuer' = ${actor.tokenId}`,
          ),
        )
        .limit(2);

      // A caller-supplied execution ID alone does not prove which generation ran.
      if (matches.length > 1)
        return privateJson(
          {
            code: "CONFLICT",
            message: "Callback address is ambiguous",
            details: { reason: "wait_callback_ambiguous" },
          },
          409,
        );
      const [match] = matches;

      if (!match || match.expired || match.state === "closed")
        return privateJson(
          { code: "NOT_FOUND", message: "Wait callback not found" },
          404,
        );

      return privateJson({ runId: match.runId, waitId: match.waitId });
    },
  );
}
