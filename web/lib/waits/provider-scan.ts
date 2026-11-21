import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Provider } from "@/lib/repo-source";
import type { PrStateReadResult } from "@/lib/runs/pr-adapter";
import type { ProviderSource } from "@/lib/waits/ci-provider";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";
import { normalizePublicationOrigin } from "../../../runtime/workspace-publication";

import { runs, runPublications, runWaits } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { getPrState } from "@/lib/runs/pr-adapter";
import { evaluateCiObservation } from "@/lib/waits/ci-evidence";
import {
  readProviderCi,
  readProviderPublicationHead,
} from "@/lib/waits/ci-provider";
import { readTrustedWaitDelivery } from "@/lib/waits/facts";
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

function publicationPrOutcome(
  observed: Extract<PrStateReadResult, { kind: "state" }>,
  publication: { sourceHead: string; baseRef: string },
): "pending" | "stale" | "merged" | "closed" | "conflict" {
  if (observed.headSha !== publication.sourceHead) return "stale";
  if (!observed.baseRef) return "pending";
  if (observed.baseRef !== publication.baseRef) return "stale";
  if (observed.state !== "open") return observed.state;

  return observed.hasConflicts ? "conflict" : "pending";
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
        const observeHead = async (): Promise<string> => {
          try {
            return await readProviderPublicationHead(source, input.fetchPage);
          } catch (error) {
            if (
              !isMaisterError(error) ||
              error.details?.status !== 404 ||
              !publication.prNumber ||
              wait.resumeState !== "applied"
            )
              throw error;
            const readPr = input.readPr ?? getPrState;
            const pr = await readPr({
              provider,
              remoteUrl,
              prNumber: publication.prNumber,
            });

            if (
              pr.kind !== "state" ||
              pr.state !== "merged" ||
              pr.headSha !== publication.sourceHead ||
              pr.baseRef !== publication.baseRef ||
              !pr.mergeCommitSha ||
              !GIT_OBJECT_ID.test(pr.mergeCommitSha)
            )
              throw error;

            return pr.headSha;
          }
        };
        const push = condition.transport === "push";
        const delivery =
          push && wait.state === "open"
            ? await readTrustedWaitDelivery(db, wait)
            : null;
        const refFact: Record<string, string> = delivery
          ? { deliveryId: delivery.sourceId }
          : {};
        const initialHead = await observeHead();
        const providerIssuer = push
          ? condition.provider_issuer
          : condition.issuer;

        // Push delivery can enter the graph even when provider check access fails.
        if (push)
          await recordPublicationObservation(db, {
            ...scope,
            kind: "ref",
            headSha: initialHead,
            fact: refFact,
          });
        const ci =
          initialHead === publication.sourceHead && providerIssuer
            ? evaluateCiObservation(
                {
                  headSha: publication.sourceHead,
                  ref: publication.headRef,
                  issuer: providerIssuer,
                  checks: condition.checks,
                },
                await readProviderCi(source, input.fetchPage),
              )
            : null;
        const headSha = ci ? await observeHead() : initialHead;

        if (!push || headSha !== initialHead)
          await recordPublicationObservation(db, {
            ...scope,
            kind: "ref",
            headSha,
            fact: refFact,
          });
        if (providerIssuer && headSha === publication.sourceHead)
          await recordPublicationObservation(db, {
            ...scope,
            kind: "ci",
            headSha,
            fact: {
              outcome: ci?.outcome ?? "pending",
              checks: [...(ci?.nonPassingChecks ?? [])],
              requiredChecks: condition.checks,
              issuer: providerIssuer,
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

        await recordPublicationObservation(db, {
          ...scope,
          kind: "pr",
          headSha: observed.headSha,
          fact: {
            outcome: publicationPrOutcome(observed, publication),
            prNumber: publication.prNumber,
            baseRef: observed.baseRef,
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
