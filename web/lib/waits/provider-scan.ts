import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Provider } from "@/lib/repo-source";
import type { ProviderSource } from "@/lib/waits/ci-provider";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { normalizePublicationOrigin } from "../../../runtime/workspace-publication";

import { runs, runPublications, runWaits } from "@/lib/db/schema";
import { getPrState } from "@/lib/runs/pr-adapter";
import { evaluateCiObservation } from "@/lib/waits/ci-evidence";
import {
  readProviderCi,
  readProviderPublicationHead,
} from "@/lib/waits/ci-provider";
import { waitConditionSchema } from "@/lib/waits/manifest";
import { recordPublicationObservation } from "@/lib/waits/publication-observations";

const log = pino({
  name: "wait-provider-scan",
  level: process.env.LOG_LEVEL ?? "info",
});

export function providerSourceForPublication(
  provider: Provider,
  publication: { repoIdentity: string; sourceHead: string; headRef: string },
): ProviderSource | null {
  if (provider !== "github" && provider !== "gitlab" && provider !== "gitea")
    return null;
  const parts = /^([A-Za-z0-9.-]+(?::[0-9]{1,5})?)\/([A-Za-z0-9_.\/-]+)$/.exec(
    publication.repoIdentity,
  );

  if (!parts) return null;
  const [, host, repository] = parts;
  const token =
    provider === "github"
      ? host === "github.com"
        ? process.env.GH_TOKEN
        : process.env.GH_ENTERPRISE_TOKEN
      : provider === "gitlab"
        ? process.env.GITLAB_TOKEN
        : process.env.GITEA_TOKEN;
  const apiBase =
    provider === "github"
      ? host === "github.com"
        ? "https://api.github.com"
        : `https://${host}/api/v3`
      : `https://${host}/api/${provider === "gitlab" ? "v4" : "v1"}`;

  return {
    provider,
    apiBase,
    token,
    repository,
    headSha: publication.sourceHead,
    ref: publication.headRef,
  };
}

export async function scanWaitPublications(input: {
  db: Db;
  projectId: string;
  provider: Provider;
  remoteUrl: string;
  deadline: number;
  readPr?: typeof getPrState;
  fetchPage?: typeof fetch;
}): Promise<void> {
  const { db, provider, remoteUrl } = input;
  const candidates = await db
    .select({ wait: runWaits, publication: runPublications })
    .from(runWaits)
    .innerJoin(runPublications, eq(runPublications.id, runWaits.publicationId))
    .innerJoin(runs, eq(runs.id, runWaits.runId))
    .where(
      and(
        eq(runWaits.projectId, input.projectId),
        eq(runPublications.phase, "observed"),
        inArray(runWaits.state, ["open", "resolved"]),
        inArray(runs.status, ["Waiting", "Pending", "Running", "Review"]),
        sql`NOT EXISTS (SELECT 1 FROM run_publications newer WHERE newer.run_id=${runPublications.runId} AND newer.generation>${runPublications.generation} AND newer.phase='observed')`,
      ),
    )
    .orderBy(
      sql`${runWaits.providerScannedAt} ASC NULLS FIRST`,
      asc(runWaits.id),
    )
    .limit(5);

  for (const { wait, publication } of candidates) {
    if (Date.now() >= input.deadline) break;
    let verifiedAt: Date | null = null;

    try {
      if (normalizePublicationOrigin(remoteUrl) !== publication.repoIdentity)
        continue;
      const scope = { publicationId: publication.id, waitId: wait.id };
      const { timeoutSeconds: _timeout, ...parameters } =
        wait.condition.parameters;
      const condition = waitConditionSchema.parse({
        kind: wait.conditionKind,
        ...parameters,
      });

      if (condition.kind === "ci") {
        const source = providerSourceForPublication(provider, publication);

        if (!source) continue;
        const initialHead = await readProviderPublicationHead(
          source,
          input.fetchPage,
        );
        const ci =
          initialHead === publication.sourceHead &&
          condition.transport === "pull"
            ? evaluateCiObservation(
                {
                  headSha: publication.sourceHead,
                  ref: publication.headRef,
                  issuer: condition.issuer,
                  checks: condition.checks,
                },
                await readProviderCi(source, input.fetchPage),
              )
            : null;
        const headSha = ci
          ? await readProviderPublicationHead(source, input.fetchPage)
          : initialHead;

        await recordPublicationObservation(db, {
          ...scope,
          kind: "ref",
          headSha,
          fact: {},
        });
        if (
          condition.transport === "pull" &&
          headSha === publication.sourceHead
        )
          await recordPublicationObservation(db, {
            ...scope,
            kind: "ci",
            headSha,
            fact: {
              outcome: ci?.outcome ?? "pending",
              checks: [...(ci?.nonPassingChecks ?? [])],
              requiredChecks: condition.checks,
              issuer: condition.issuer,
            },
          });
        verifiedAt = new Date();
      } else if (condition.kind === "pr" && publication.prNumber) {
        const readPr = input.readPr ?? getPrState;
        const observed = await readPr({
          provider,
          remoteUrl,
          prNumber: publication.prNumber,
        });

        if (observed.kind !== "state" || !observed.headSha) continue;
        const outcome =
          observed.headSha !== publication.sourceHead
            ? "stale"
            : observed.state !== "open"
              ? observed.state
              : observed.hasConflicts
                ? "conflict"
                : "pending";

        await recordPublicationObservation(db, {
          ...scope,
          kind: "pr",
          headSha: observed.headSha,
          fact: {
            outcome,
            prNumber: publication.prNumber,
            mergedAt: observed.mergedAt,
            mergeCommitSha: observed.mergeCommitSha,
          },
        });
        verifiedAt = new Date();
      }
    } catch (error: unknown) {
      log.warn(
        {
          waitId: wait.id,
          publicationId: publication.id,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "provider wait observation deferred",
      );
    } finally {
      await db
        .update(runWaits)
        .set({ providerScannedAt: new Date(), providerVerifiedAt: verifiedAt })
        .where(eq(runWaits.id, wait.id));
    }
  }
}
