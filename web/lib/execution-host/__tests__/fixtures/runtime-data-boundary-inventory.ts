export type RuntimeDataBoundaryClass =
  | "host-runtime-legacy"
  | "manager-flow-config"
  | "manager-repository"
  | "manager-evidence"
  | "unrelated-tooling";

export type RuntimeDataDisposition =
  | "stage-b-remove"
  | "stage-c-defer"
  | "retain";

export type RuntimeDataBoundaryEntry = Readonly<{
  source: string;
  observation: "direct-filesystem-access" | "runtime-path-constructor";
  classification: RuntimeDataBoundaryClass;
  disposition: RuntimeDataDisposition;
  removalTask: string;
}>;

function entries(
  sources: readonly string[],
  observation: RuntimeDataBoundaryEntry["observation"],
  classification: RuntimeDataBoundaryClass,
  disposition: RuntimeDataDisposition,
  removalTask: string,
): readonly RuntimeDataBoundaryEntry[] {
  return sources.map((source) => ({
    source,
    observation,
    classification,
    disposition,
    removalTask,
  }));
}

const HOST_RUNTIME_DIRECT = [
  "app/api/runs/[runId]/stream/route.ts",
  "lib/agents/launch.ts",
  "lib/agents/memory-store.ts",
  "lib/flows/graph/default-artifacts.ts",
  "lib/flows/graph/node-output.ts",
  "lib/flows/graph/plan-review-artifact.ts",
  "lib/flows/graph/runner-graph.ts",
  "lib/projector/artifact-projector.ts",
  "lib/queries/inbox-context.ts",
  "lib/runs/cost-rollups.ts",
  "lib/runs/hook-trip.ts",
  "lib/runs/keepalive-sweeper.ts",
  "lib/runs/node-interrupt.ts",
  "lib/runs/run-stream-event.ts",
  "lib/runs/run-transcript-projector.ts",
  "lib/scratch-runs/available-commands.ts",
  "lib/scratch-runs/service.ts",
  "lib/services/runs.ts",
] as const;

const MANAGER_FLOW_DIRECT = [
  "lib/atomic.ts",
  "lib/config.ts",
  "lib/context-mounts/terminal.ts",
  "lib/flows.ts",
  "lib/flows/authored-bridge.ts",
  "lib/flows/graph/consensus/runtime.ts",
  "lib/flows/lifecycle.ts",
  "lib/flows/package-authoring.ts",
  "lib/flows/package-content.ts",
  "lib/flows/runner-cli.ts",
  "lib/persist-config.ts",
  "lib/studio/flow-assistant/action-log.ts",
] as const;

const MANAGER_REPOSITORY_DIRECT = [
  "app/api/admin/agents/[agentId]/route.ts",
  "app/api/projects/route.ts",
  "lib/agents/dirty-watchdog.ts",
  "lib/agents/effective.ts",
  "lib/agents/facade-launch.ts",
  "lib/agents/flow-binding.ts",
  "lib/agents/materialization-lock.ts",
  "lib/agents/materialization-manifest.ts",
  "lib/agents/registry.ts",
  "lib/capabilities/adapter-home.ts",
  "lib/capabilities/cleanup.ts",
  "lib/capabilities/import.ts",
  "lib/capabilities/materialize-bundle.ts",
  "lib/capabilities/materialize.ts",
  "lib/capabilities/settings-ownership.ts",
  "lib/execution-host/adoption.ts",
  "lib/flows/graph/artifact-content.ts",
  "lib/flows/graph/mutation-check.ts",
  "lib/flows/graph/workspace-checkpoint.ts",
  "lib/gc/agent-materialization-gc.ts",
  "lib/gc/context-mount-gc.ts",
  "lib/gc/ephemeral-agent-gc.ts",
  "lib/gc/plain-agent-directory-gc.ts",
  "lib/gc/revision-gc.ts",
  "lib/gc/workspace-gc.ts",
  "lib/gc/workspace-reconciler.ts",
  "lib/local-packages/bom.ts",
  "lib/local-packages/create-flow-operation.ts",
  "lib/local-packages/divergence.ts",
  "lib/local-packages/fork.ts",
  "lib/local-packages/git.ts",
  "lib/local-packages/import.ts",
  "lib/local-packages/paths.ts",
  "lib/local-packages/service.ts",
  "lib/local-packages/sync-merge.ts",
  "lib/local-packages/sync.ts",
  "lib/local-packages/versions.ts",
  "lib/packages/attach.ts",
  "lib/packages/catalog.ts",
  "lib/packages/install.ts",
  "lib/packages/manifest.ts",
  "lib/packages/yaml-writeback.ts",
  "lib/repo-source.ts",
  "lib/scratch-runs/local-package-materialization.ts",
  "lib/services/gate-chat.ts",
  "lib/workbench-lifecycle/service.ts",
  "lib/worktree-provenance.ts",
  "lib/worktree.ts",
] as const;

const MANAGER_EVIDENCE_DIRECT = [
  "lib/evaluations/evidence/store.ts",
  "lib/evaluations/method.ts",
] as const;

const UNRELATED_DIRECT = [
  "lib/db/check-migrations.ts",
  "lib/db/m43-cutover-migration-root.ts",
  "lib/db/migrate.ts",
] as const;

const HOST_RUNTIME_CONSTRUCTORS = [
  "app/api/runs/[runId]/artifacts/[artifactId]/payload/route.ts",
  "app/api/runs/[runId]/cost-summary/route.ts",
  "lib/execution-host/signals.ts",
  "lib/flows/child-env.ts",
  "lib/flows/flow-dsl-grammar.ts",
  "lib/run-transcript/coalesce.ts",
  "lib/runs/cost-reconcile-sweep.ts",
  "lib/runs/exec-policy-audit.ts",
  "lib/runs/launch-progress.ts",
  "lib/supervisor-client.ts",
] as const;

const MANAGER_FLOW_CONSTRUCTORS = [
  "lib/flows/graph/gates-exec.ts",
  "lib/instance-config.ts",
  "lib/runtime-root.ts",
  "lib/services/hitl.ts",
  "lib/studio/flow-assistant/run-artifacts.ts",
] as const;

const MANAGER_REPOSITORY_CONSTRUCTORS = [
  "lib/context-mounts/service.ts",
] as const;

const HOST_RUNTIME_SCHEMA_CONSTRUCTORS = ["lib/db/schema.ts"] as const;

export const runtimeDataBoundaryInventory = [
  ...entries(
    HOST_RUNTIME_DIRECT,
    "direct-filesystem-access",
    "host-runtime-legacy",
    "stage-b-remove",
    "T3.5",
  ),
  ...entries(
    MANAGER_FLOW_DIRECT,
    "direct-filesystem-access",
    "manager-flow-config",
    "retain",
    "Stage C repository/workspace cut",
  ),
  ...entries(
    MANAGER_REPOSITORY_DIRECT,
    "direct-filesystem-access",
    "manager-repository",
    "stage-c-defer",
    "Stage C repository/workspace cut",
  ),
  ...entries(
    MANAGER_EVIDENCE_DIRECT,
    "direct-filesystem-access",
    "manager-evidence",
    "retain",
    "Retain manager-owned evidence store",
  ),
  ...entries(
    UNRELATED_DIRECT,
    "direct-filesystem-access",
    "unrelated-tooling",
    "retain",
    "Retain migration tooling",
  ),
  ...entries(
    HOST_RUNTIME_CONSTRUCTORS,
    "runtime-path-constructor",
    "host-runtime-legacy",
    "stage-b-remove",
    "T3.5",
  ),
  ...entries(
    MANAGER_FLOW_CONSTRUCTORS,
    "runtime-path-constructor",
    "manager-flow-config",
    "retain",
    "Retain manager-owned flow state",
  ),
  ...entries(
    MANAGER_REPOSITORY_CONSTRUCTORS,
    "runtime-path-constructor",
    "manager-repository",
    "stage-c-defer",
    "Stage C repository/workspace cut",
  ),
  ...entries(
    HOST_RUNTIME_SCHEMA_CONSTRUCTORS,
    "runtime-path-constructor",
    "host-runtime-legacy",
    "stage-b-remove",
    "T4.3",
  ),
] as const satisfies readonly RuntimeDataBoundaryEntry[];

export const requiredLegacyRuntimeSources = [
  ...HOST_RUNTIME_DIRECT,
  ...HOST_RUNTIME_CONSTRUCTORS,
  ...HOST_RUNTIME_SCHEMA_CONSTRUCTORS,
] as const;
