import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type {
  ArtifactInstance,
  GateResult,
  NodeAttempt,
} from "@/lib/db/schema";
import type { CheckStrictness } from "@/lib/runs/execution-policy";

import {
  blockingGateContribution,
  collapseLatestExternalPerGate,
  isPolicySkippedGate,
  latestAttemptIdsByNode,
  liveBlockingGates,
} from "@/lib/flows/graph/readiness-core";

export type ResultItem = Readonly<{
  id: string;
  kind: "stage" | "artifact" | "check" | "decision" | "missing";
  label: string;
  state: string;
  nodeId?: string;
  attempt?: number;
  artifactId?: string;
  artifactKind?: string;
  format?: "diff" | "markdown" | "generic";
  partial?: boolean;
  truncated?: boolean;
  provenance?: { kind: "commit" | "ref"; value: string };
  revision?: string;
  source?: "machine" | "external" | "agent" | "human" | "evidence";
  applicability?: "blocking" | "advisory" | "excluded";
  blocking?: boolean;
  exitCode?: number;
}>;

export type RunResultsAndChecks = Readonly<{
  current: ResultItem[];
  checks: ResultItem[];
  previous: ResultItem[];
}>;

export type EvidenceAttempt = Pick<
  NodeAttempt,
  "id" | "nodeId" | "nodeType" | "attempt" | "status" | "startedAt"
> & {
  exitCode: number | null;
};
export type EvidenceGate = Pick<
  GateResult,
  | "id"
  | "nodeAttemptId"
  | "gateId"
  | "kind"
  | "mode"
  | "status"
  | "inputArtifactRefs"
  | "createdAt"
> & {
  commitSha: string | null;
  assertionFailed: boolean | null;
};
export type EvidenceArtifact = Pick<
  ArtifactInstance,
  "id" | "nodeAttemptId" | "nodeId" | "kind" | "validity" | "supersededById"
> & {
  defId: string | null;
  headRef: string | null;
  markdown: boolean | null;
  partial: boolean | null;
  truncated: boolean | null;
};
export type EvidenceDecision = {
  id: string;
  kind: string;
  decision: string | null;
  stepId: string | null;
};

function provenance(value: string | null): ResultItem["provenance"] {
  if (!value) return undefined;
  if (/^[0-9a-f]{40,64}$/i.test(value)) return { kind: "commit", value };
  if (
    /^refs\/(?:heads|tags|remotes|maister)\/[A-Za-z0-9._/-]{1,240}$/.test(value)
  )
    return { kind: "ref", value };

  return undefined;
}

function gateSource(kind: string): NonNullable<ResultItem["source"]> {
  switch (kind) {
    case "command_check":
      return "machine";
    case "external_check":
      return "external";
    case "human_review":
      return "human";
    case "ai_judgment":
    case "skill_check":
      return "agent";
    default:
      return "evidence";
  }
}

type ProjectionInput = Readonly<{
  attempts: EvidenceAttempt[];
  artifacts: EvidenceArtifact[];
  gates: EvidenceGate[];
  decisions: EvidenceDecision[];
  checks: CheckStrictness;
  manifest: FlowYamlV1 | null;
  revision: string | null;
}>;

export function projectRunResultsAndChecks(
  input: ProjectionInput,
): RunResultsAndChecks {
  const { attempts, artifacts, gates, decisions, checks, manifest, revision } =
    input;
  const current: ResultItem[] = [];
  const checkItems: ResultItem[] = [];
  const previous: ResultItem[] = [];
  const latestAttempts = latestAttemptIdsByNode(attempts);
  const attemptsById = new Map(
    attempts.map((attempt) => [attempt.id, attempt]),
  );
  const declarations = new Map(
    manifest?.nodes.flatMap((node) =>
      (node.output?.produces ?? []).map(
        (entry) => [entry.id, { ...entry, nodeId: node.id }] as const,
      ),
    ),
  );
  const currentDefinitions = new Set(
    artifacts.flatMap((artifact) =>
      artifact.validity === "current" && artifact.defId ? [artifact.defId] : [],
    ),
  );

  for (const attempt of attempts) {
    const row: ResultItem = {
      id: `na:${attempt.id}`,
      kind: "stage",
      label: attempt.nodeId,
      state: attempt.status,
      nodeId: attempt.nodeId,
      attempt: attempt.attempt,
      ...(attempt.exitCode === null
        ? {}
        : { source: "machine", exitCode: attempt.exitCode }),
    };

    (latestAttempts.has(attempt.id) ? current : previous).push(row);
  }
  for (const artifact of artifacts) {
    const owner = artifact.nodeAttemptId
      ? attemptsById.get(artifact.nodeAttemptId)
      : undefined;
    const declaration = artifact.defId
      ? declarations.get(artifact.defId)
      : undefined;
    const row: ResultItem = {
      id: `art:${artifact.id}`,
      kind: "artifact",
      label: declaration?.id ?? artifact.kind,
      state: artifact.validity,
      nodeId: owner?.nodeId ?? artifact.nodeId ?? declaration?.nodeId,
      attempt: owner?.attempt,
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      format:
        artifact.kind === "diff"
          ? "diff"
          : artifact.markdown
            ? "markdown"
            : "generic",
      partial: artifact.partial === true,
      truncated: artifact.truncated === true,
      provenance: provenance(artifact.headRef),
      revision: revision ?? undefined,
    };

    (artifact.validity === "current" ? current : previous).push(row);
  }
  for (const declaration of declarations.values()) {
    if (
      !declaration.requiredFor?.length ||
      currentDefinitions.has(declaration.id)
    )
      continue;
    current.push({
      id: `required:${declaration.id}`,
      kind: "missing",
      label: declaration.id,
      nodeId: declaration.nodeId,
      state: "missing",
      artifactKind: declaration.kind,
    });
  }

  const live = gates.filter((gate) => latestAttempts.has(gate.nodeAttemptId));
  const newest = new Set(
    [
      ...collapseLatestExternalPerGate(
        live.filter((gate) => gate.kind === "external_check"),
        (gate) => gate.gateId,
      ),
      ...collapseLatestExternalPerGate(
        live.filter((gate) => gate.kind !== "external_check"),
        (gate) => JSON.stringify([gate.nodeAttemptId, gate.gateId]),
      ),
    ].map((gate) => gate.id),
  );
  const effectiveBlocking = new Set(
    liveBlockingGates(
      gates.filter((gate) => newest.has(gate.id)),
      latestAttempts,
      checks,
    ).map((gate) => gate.id),
  );

  for (const gate of gates) {
    const owner = attemptsById.get(gate.nodeAttemptId);
    const contribution = blockingGateContribution(
      {
        ...gate,
        verdict: { payload: { assertionFailed: gate.assertionFailed } },
      },
      currentDefinitions,
    );
    const effective = effectiveBlocking.has(gate.id);
    const row: ResultItem = {
      id: `gate:${gate.id}`,
      kind: "check",
      label: gate.gateId,
      state: gate.status,
      nodeId: owner?.nodeId,
      attempt: owner?.attempt,
      source: gate.status === "overridden" ? "human" : gateSource(gate.kind),
      applicability: isPolicySkippedGate(checks, gate.kind)
        ? "excluded"
        : effective
          ? "blocking"
          : "advisory",
      blocking:
        effective && contribution !== "clear" && contribution !== "overridden",
      provenance: provenance(gate.commitSha),
    };

    (newest.has(gate.id) ? checkItems : previous).push(row);
  }

  for (const decision of decisions) {
    if (!decision.decision) continue;
    checkItems.push({
      id: `dec:${decision.id}`,
      kind: "decision",
      label: decision.stepId ?? decision.kind,
      nodeId: decision.stepId ?? undefined,
      state: decision.decision,
      source: "human",
    });
  }

  return { current, checks: checkItems, previous };
}
