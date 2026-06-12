import { MaisterError } from "@/lib/errors";

export type RunnerResolutionTier =
  | "launchOverride"
  | "stepTarget"
  | "projectFlowDefault"
  | "platformFlowDefault"
  | "projectDefault"
  | "platformDefault"
  // M34 (ADR-089): standalone agent chain tiers.
  | "agentLinkOverride"
  | "agentDefault";

export type RunnerCatalogEntry = {
  readonly id: string;
  readonly adapter: string;
  readonly capabilityAgent: string;
  readonly model: string;
  readonly provider?: PlatformRunnerProvider;
  readonly providerKind: string;
  readonly permissionPolicy: string;
  readonly sidecar?: RunnerSidecarSnapshot | null;
  readonly sidecarId?: string | null;
  readonly enabled: boolean;
  readonly ready: boolean;
};

export type PlatformRunnerProvider =
  | { kind: "anthropic" }
  | { kind: "anthropic_compatible"; baseUrl?: string; authToken?: string }
  | { kind: "openai" }
  | {
      kind: "openai_compatible";
      baseUrl?: string;
      apiKey?: string;
      wireApi?: "responses";
    }
  | { kind: "google_gemini"; apiKey?: string }
  | {
      kind: "google_vertex";
      projectId?: string;
      location?: string;
      apiKey?: string;
    }
  | { kind: "google_gateway"; baseUrl?: string; apiKey?: string }
  | { kind: "agent_native" };

export type RunnerSidecarSnapshot = {
  readonly id: string;
  readonly kind: "ccr";
  readonly lifecycle?: "managed" | "external";
  readonly configPath?: string | null;
  readonly baseUrl?: string | null;
  readonly healthcheckUrl?: string | null;
  readonly authTokenRef?: string | null;
};

export type RunnerResolutionInput = {
  readonly launchOverrideRunnerId?: string | null;
  readonly step: { readonly runnerId?: string | null };
  readonly projectFlow: { readonly defaultRunnerId?: string | null };
  readonly platformFlow: { readonly defaultRunnerId?: string | null };
  readonly project: { readonly defaultRunnerId?: string | null };
  readonly platform: { readonly defaultRunnerId: string };
  readonly runners: readonly RunnerCatalogEntry[];
};

export type RunnerSnapshot = {
  readonly id: string;
  readonly adapter: string;
  readonly capabilityAgent: string;
  readonly model: string;
  readonly provider?: PlatformRunnerProvider;
  readonly providerKind: string;
  readonly permissionPolicy: string;
  readonly sidecar?: RunnerSidecarSnapshot | null;
  readonly sidecarId?: string | null;
};

export type RunnerResolution = {
  readonly runnerId: string;
  readonly runnerResolutionTier: RunnerResolutionTier;
  readonly capabilityAgent: string;
  readonly runnerSnapshot: RunnerSnapshot;
};

type Candidate = {
  readonly tier: RunnerResolutionTier;
  readonly runnerId?: string | null;
};

function formatCandidate(candidate: Candidate): string {
  return `${candidate.tier}:${candidate.runnerId ?? "<unset>"}`;
}

function snapshotRunner(runner: RunnerCatalogEntry): RunnerSnapshot {
  return {
    id: runner.id,
    adapter: runner.adapter,
    capabilityAgent: runner.capabilityAgent,
    model: runner.model,
    provider: runner.provider,
    providerKind: runner.providerKind,
    permissionPolicy: runner.permissionPolicy,
    sidecar: runner.sidecar,
    sidecarId: runner.sidecarId,
  };
}

function assertLaunchableRunner(
  candidate: Candidate,
  runner: RunnerCatalogEntry | undefined,
): RunnerCatalogEntry {
  if (!runner) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `ACP runner ${candidate.runnerId} referenced by ${candidate.tier} is missing; refusing fallback`,
    );
  }

  if (!runner.enabled) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `ACP runner ${runner.id} referenced by ${candidate.tier} is disabled; refusing fallback`,
    );
  }

  if (!runner.ready) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `ACP runner ${runner.id} referenced by ${candidate.tier} is not ready; refusing fallback`,
    );
  }

  return runner;
}

export type AgentRunnerResolutionInput = {
  readonly launchOverrideRunnerId?: string | null;
  readonly link: { readonly runnerOverrideId?: string | null };
  readonly agent: {
    readonly runnerId?: string | null;
    readonly mode: "session" | "subagent";
    readonly workspace: "none" | "repo_read" | "worktree";
  };
  readonly project: { readonly defaultRunnerId?: string | null };
  readonly platform: { readonly defaultRunnerId: string };
  readonly runners: readonly RunnerCatalogEntry[];
};

// M34 (ADR-089): the standalone agent chain — flow tiers do not participate.
// Two compatibility refusals fire BEFORE spawn: subagent definitions are
// Claude-SDK artifacts, and dangerously_skip_permissions suppresses the very
// permission requests the ADR-090 L1 read-only layer arbitrates.
export function resolveAgentRunner(
  input: AgentRunnerResolutionInput,
): RunnerResolution {
  const candidates: readonly Candidate[] = [
    { tier: "launchOverride", runnerId: input.launchOverrideRunnerId },
    { tier: "agentLinkOverride", runnerId: input.link.runnerOverrideId },
    { tier: "agentDefault", runnerId: input.agent.runnerId },
    { tier: "projectDefault", runnerId: input.project.defaultRunnerId },
    { tier: "platformDefault", runnerId: input.platform.defaultRunnerId },
  ];
  const runnerById = new Map(
    input.runners.map((runner) => [runner.id, runner]),
  );

  for (const candidate of candidates) {
    if (!candidate.runnerId) continue;
    const runner = assertLaunchableRunner(
      candidate,
      runnerById.get(candidate.runnerId),
    );

    if (
      input.agent.mode === "subagent" &&
      runner.capabilityAgent !== "claude"
    ) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `agent runner ${runner.id} (capability ${runner.capabilityAgent}) cannot host a subagent-mode definition — .claude/agents materialization requires a claude-capability runner`,
      );
    }

    if (
      input.agent.workspace !== "worktree" &&
      runner.permissionPolicy === "dangerously_skip_permissions"
    ) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `agent runner ${runner.id} uses dangerously_skip_permissions — incompatible with the ${input.agent.workspace} workspace read-only enforcement (ADR-090 L1)`,
      );
    }

    return {
      runnerId: runner.id,
      runnerResolutionTier: candidate.tier,
      capabilityAgent: runner.capabilityAgent,
      runnerSnapshot: snapshotRunner(runner),
    };
  }

  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    `no ACP runner resolved for agent (${candidates.map(formatCandidate).join(", ")})`,
  );
}

export function resolveRunner(input: RunnerResolutionInput): RunnerResolution {
  const candidates: readonly Candidate[] = [
    { tier: "launchOverride", runnerId: input.launchOverrideRunnerId },
    { tier: "stepTarget", runnerId: input.step.runnerId },
    {
      tier: "projectFlowDefault",
      runnerId: input.projectFlow.defaultRunnerId,
    },
    {
      tier: "platformFlowDefault",
      runnerId: input.platformFlow.defaultRunnerId,
    },
    { tier: "projectDefault", runnerId: input.project.defaultRunnerId },
    { tier: "platformDefault", runnerId: input.platform.defaultRunnerId },
  ];
  const runnerById = new Map(
    input.runners.map((runner) => [runner.id, runner]),
  );

  for (const candidate of candidates) {
    if (!candidate.runnerId) continue;
    const runner = assertLaunchableRunner(
      candidate,
      runnerById.get(candidate.runnerId),
    );

    return {
      runnerId: runner.id,
      runnerResolutionTier: candidate.tier,
      capabilityAgent: runner.capabilityAgent,
      runnerSnapshot: snapshotRunner(runner),
    };
  }

  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    `no ACP runner resolved (${candidates.map(formatCandidate).join(", ")})`,
  );
}
