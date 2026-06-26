import type { FlowRunnerConfig, RunnerSlot } from "@/lib/config.schema";

import { runnerSlotProfileRef } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";

export type RunnerResolutionTier =
  | "launchOverride"
  | "stepTarget"
  // M42 (ADR-114): per-slot binding + unique host auto-match tiers.
  | "binding"
  | "autoMatch"
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
  readonly env?: Record<string, string>;
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
  readonly env?: Record<string, string>;
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
    env: runner.env,
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

    if (
      input.agent.workspace !== "worktree" &&
      runner.capabilityAgent !== "claude"
    ) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `agent runner ${runner.id} (capability ${runner.capabilityAgent}) cannot host a ${input.agent.workspace} agent — read-only enforcement requires a claude-capability runner`,
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

// M42 (ADR-114): the `run_sessions` field map for the single `default` session
// of a non-flow run (scratch / agent / consensus-child). The caller adds the
// `id` (and runs it inside the run-insert transaction). `acp_session_id` is null
// until the supervisor session spawns.
export function defaultRunSessionValues(
  runId: string,
  resolution: RunnerResolution,
): {
  runId: string;
  sessionName: "default";
  runnerId: string;
  runnerResolutionTier: RunnerResolutionTier;
  capabilityAgent: string;
  runnerSnapshot: RunnerSnapshot;
  acpSessionId: null;
  resolutionSource: string;
} {
  return {
    runId,
    sessionName: "default",
    runnerId: resolution.runnerId,
    runnerResolutionTier: resolution.runnerResolutionTier,
    capabilityAgent: resolution.capabilityAgent,
    runnerSnapshot: resolution.runnerSnapshot,
    acpSessionId: null,
    resolutionSource: resolution.runnerResolutionTier,
  };
}

// M42 (ADR-114): per-session / per-consensus-slot runner resolution.
//
// A flow run no longer resolves ONE runner — it resolves one runner per logical
// session (and each consensus participant/synthesizer is a separate slot). Every
// bindable slot has a stable `slotKey` (see `runner-slots.ts`). The unified
// resolver below replaces the legacy `resolveCompiledStepTargetRunnerId` +
// single `resolveRunner` path for runner-bearing flow nodes.

// A per-slot binding row (`flow_runner_remaps`) — the connect-time / first-launch
// mapping of a portable slot to a concrete host runner.
export type RunnerSlotBinding = {
  readonly slotKey: string;
  readonly mappedRunnerId: string | null;
  readonly status: "Pending" | "Mapped";
};

// A logical session (or any bindable slot) and its declared runner config. The
// implicit `default` session carries `runner: undefined` and resolves via the
// project/platform default chain; every other slot declares a runner config.
export type RunSessionSlot = {
  readonly name: string;
  readonly runner?: RunnerSlot;
};

export type ResolvedRunnerSlot = RunnerResolution & {
  // The concrete source that resolved this slot — the `slotKey` for a
  // binding/auto-match/host-ref, a chain-tier name for the default chain, or
  // "launch-dialog" for an ephemeral per-run override. Persisted to
  // `run_sessions.resolution_source` for audit.
  readonly resolutionSource: string;
};

export type RunSessionResolution = ResolvedRunnerSlot & {
  readonly sessionName: string;
};

// Deref a runner slot to its concrete unified config: a bare string resolves
// through the manifest `runner_profiles`; an inline object IS the config.
export function resolveSlotConfig(
  slot: RunnerSlot,
  runnerProfiles: Record<string, FlowRunnerConfig> | undefined,
): FlowRunnerConfig {
  if (typeof slot !== "string") return slot;

  const profile = runnerProfiles?.[slot];

  if (!profile) {
    throw new MaisterError(
      "CONFIG",
      `runner slot references unknown runner profile "${slot}"`,
    );
  }

  return profile;
}

// Match a runner config to host runners by INTENT (capability_agent, plus model
// and provider.kind when the config pins them). Only enabled+ready catalog
// runners are eligible. Returns ALL matches so the caller can distinguish a
// unique auto-match (1) from ambiguity (>1 → needs a binding) and no host (0).
export function autoMatchRunners(
  config: FlowRunnerConfig,
  runners: readonly RunnerCatalogEntry[],
): RunnerCatalogEntry[] {
  return runners.filter((runner) => {
    if (!runner.enabled || !runner.ready) return false;
    if (runner.capabilityAgent !== config.capability_agent) return false;
    if (config.model !== undefined && runner.model !== config.model) {
      return false;
    }
    if (
      config.provider?.kind !== undefined &&
      runner.providerKind !== config.provider.kind
    ) {
      return false;
    }

    return true;
  });
}

function intentLabel(config: FlowRunnerConfig): string {
  return [
    `capability=${config.capability_agent}`,
    config.model ? `model=${config.model}` : null,
    config.provider?.kind ? `provider=${config.provider.kind}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export type RunnerSlotResolutionInput = {
  readonly slotKey: string;
  readonly slot: RunnerSlot | undefined;
  // Ephemeral per-run override (Launch dialog) — wins over everything.
  readonly overrideRunnerId?: string | null;
  readonly binding?: RunnerSlotBinding;
  readonly runnerProfiles: Record<string, FlowRunnerConfig> | undefined;
  readonly runners: readonly RunnerCatalogEntry[];
};

// Resolve ONE bindable slot through the config-driven tiers:
//   override → Mapped binding → host-id profile-ref → unique intent auto-match.
// Returns `null` ONLY when the slot has no declared runner AND no override/
// binding (the implicit `default` session — the caller applies the default
// chain). Throws CONFIG (ambiguous / unbound) or EXECUTOR_UNAVAILABLE (no host).
export function resolveRunnerSlot(
  input: RunnerSlotResolutionInput,
): ResolvedRunnerSlot | null {
  const runnerById = new Map(
    input.runners.map((runner) => [runner.id, runner]),
  );

  const resolved = (
    tier: RunnerResolutionTier,
    runner: RunnerCatalogEntry,
    resolutionSource: string,
  ): ResolvedRunnerSlot => ({
    runnerId: runner.id,
    runnerResolutionTier: tier,
    capabilityAgent: runner.capabilityAgent,
    runnerSnapshot: snapshotRunner(runner),
    resolutionSource,
  });

  // 1. Ephemeral per-run override.
  if (input.overrideRunnerId) {
    const runner = assertLaunchableRunner(
      { tier: "launchOverride", runnerId: input.overrideRunnerId },
      runnerById.get(input.overrideRunnerId),
    );

    return resolved("launchOverride", runner, "launch-dialog");
  }

  // 2. Mapped per-slot binding (connect-time / first-launch).
  if (input.binding?.status === "Mapped" && input.binding.mappedRunnerId) {
    const runner = assertLaunchableRunner(
      { tier: "binding", runnerId: input.binding.mappedRunnerId },
      runnerById.get(input.binding.mappedRunnerId),
    );

    return resolved("binding", runner, input.slotKey);
  }

  // No declared runner → the default chain handles it (caller).
  if (input.slot === undefined) return null;

  // 3. A bare profile-ref that IS a concrete host runner id.
  const ref = runnerSlotProfileRef(input.slot);

  if (ref !== undefined && runnerById.has(ref)) {
    const runner = assertLaunchableRunner(
      { tier: "stepTarget", runnerId: ref },
      runnerById.get(ref),
    );

    return resolved("stepTarget", runner, input.slotKey);
  }

  // 4. Auto-match the unified config to a UNIQUE host runner by intent.
  const config = resolveSlotConfig(input.slot, input.runnerProfiles);
  const matches = autoMatchRunners(config, input.runners);

  if (matches.length === 1) {
    return resolved("autoMatch", matches[0], input.slotKey);
  }

  if (matches.length > 1) {
    throw new MaisterError(
      "CONFIG",
      `runner slot "${input.slotKey}" matches ${matches.length} host runners by intent (${intentLabel(config)}); requires a per-project binding`,
    );
  }

  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    `runner slot "${input.slotKey}" has no enabled+ready host runner matching intent (${intentLabel(config)})`,
  );
}

export type RunSessionResolutionInput = {
  readonly sessions: readonly RunSessionSlot[];
  readonly runnerProfiles: Record<string, FlowRunnerConfig> | undefined;
  readonly bindings: readonly RunnerSlotBinding[];
  // Optional ephemeral per-run overrides keyed by session name (Launch dialog).
  readonly ephemeralOverrides?: Readonly<Record<string, string | null>>;
  // The `default`-session-only fallback chain (a config-less default session).
  readonly projectFlow: { readonly defaultRunnerId?: string | null };
  readonly platformFlow: { readonly defaultRunnerId?: string | null };
  readonly project: { readonly defaultRunnerId?: string | null };
  readonly platform: { readonly defaultRunnerId: string };
  readonly runners: readonly RunnerCatalogEntry[];
};

// Resolve every logical session in a run to a concrete host runner. One row per
// session; the order mirrors the compiled `FlowGraph.sessions` iteration order.
export function resolveRunSessions(
  input: RunSessionResolutionInput,
): RunSessionResolution[] {
  const runnerById = new Map(
    input.runners.map((runner) => [runner.id, runner]),
  );
  const bindingBySlotKey = new Map(
    input.bindings.map((binding) => [binding.slotKey, binding]),
  );
  const out: RunSessionResolution[] = [];

  for (const session of input.sessions) {
    const slotKey = `session:${session.name}`;
    const slotResolution = resolveRunnerSlot({
      slotKey,
      slot: session.runner,
      overrideRunnerId: input.ephemeralOverrides?.[session.name],
      binding: bindingBySlotKey.get(slotKey),
      runnerProfiles: input.runnerProfiles,
      runners: input.runners,
    });

    if (slotResolution) {
      out.push({ ...slotResolution, sessionName: session.name });
      continue;
    }

    // Config-less session (only the implicit `default`): the project/platform
    // default chain. The top two flow tiers are NOT dropped — they are the
    // session-default fallback when no runner is declared.
    const chain: readonly Candidate[] = [
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

    let picked: RunSessionResolution | null = null;

    for (const candidate of chain) {
      if (!candidate.runnerId) continue;

      const runner = assertLaunchableRunner(
        candidate,
        runnerById.get(candidate.runnerId),
      );

      picked = {
        sessionName: session.name,
        runnerId: runner.id,
        runnerResolutionTier: candidate.tier,
        capabilityAgent: runner.capabilityAgent,
        runnerSnapshot: snapshotRunner(runner),
        resolutionSource: candidate.tier,
      };
      break;
    }

    if (!picked) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `no ACP runner resolved for session "${session.name}" (${chain.map(formatCandidate).join(", ")})`,
      );
    }

    out.push(picked);
  }

  return out;
}
