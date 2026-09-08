import type { FilesystemOperation } from "@/test-support/filesystem-ownership";

// D10 (AB-16): the operation-scoped filesystem ownership inventory of the
// web tier. Every entry names ONE callsite — source file, enclosing function,
// resolved callee and operation (plus the literal command for a spawn) — and
// the ownership class the manager holds for it. There is no file-level
// exemption: a new callsite in an already classified file needs its own line.
//
// Wrappers are exported production functions that perform a filesystem effect
// (directly or through local helpers). Each is listed with the class it
// serves and whether it is PATH-GENERIC — the caller chooses the location, so
// every call of it is enumerated per caller (e.g. `atomicWriteJson`). Calls of
// non-path-generic wrappers are covered by the wrapper's own callsites.
//
// Maintenance: `runtime-data-boundary-inventory.test.ts` prints every
// unclassified callsite as the tuple to add here. Classes:
//   manager-flow-state   flow/config/run-input state the manager owns
//   manager-evidence     the Evaluation Lab evidence store
//   repository-worktree  git, worktree, package and capability materialization
//                        on the shared checkout, retained until Stage C
//   migration-tooling    Drizzle migration files (operator CLI + boot check)
//   operator-import      the Stage A history importer (explicit authority)
//   build-tooling        build/CI scripts that never run in the web process
//   supervisor-runtime   host-private runtime bytes/state — FORBIDDEN here
export type FilesystemOwnershipClass =
  | "manager-flow-state"
  | "manager-evidence"
  | "repository-worktree"
  | "migration-tooling"
  | "operator-import"
  | "build-tooling"
  | "supervisor-runtime";

export type FilesystemOwnershipEntry = Readonly<{
  source: string;
  enclosing: string;
  callee: string;
  operation: FilesystemOperation;
  command: string | null;
  class: FilesystemOwnershipClass;
  rationale: string;
  authority?: string;
  lifetime?: string;
}>;

export type FilesystemWrapperEntry = Readonly<{
  wrapper: string;
  class: FilesystemOwnershipClass;
  pathGeneric: boolean;
}>;

type CallsiteTuple = readonly [
  enclosing: string,
  callee: string,
  operation: FilesystemOperation,
  command?: string | null,
];

type Authority = Readonly<{ authority: string; lifetime: string }>;

function classified(
  source: string,
  ownership: FilesystemOwnershipClass,
  rationale: string,
  callsites: readonly CallsiteTuple[],
  authority?: Authority,
): FilesystemOwnershipEntry[] {
  return callsites.map(([enclosing, callee, operation, command]) => ({
    source,
    enclosing,
    callee,
    operation,
    command: command ?? null,
    class: ownership,
    rationale,
    ...(authority ?? {}),
  }));
}

function wrappers(
  module: string,
  ownership: FilesystemOwnershipClass,
  functions: readonly (readonly [name: string, pathGeneric: boolean])[],
): FilesystemWrapperEntry[] {
  return functions.map(([name, pathGeneric]) => ({
    wrapper: `${module}#${name}`,
    class: ownership,
    pathGeneric,
  }));
}

export const filesystemOwnershipInventory: readonly FilesystemOwnershipEntry[] =
  [
    ...classified(
      "app/(app)/projects/[slug]/packages/[flowRefId]/page.tsx",
      "manager-flow-state",
      "pages rendering installed package content through the confined package-content readers",
      [
        [
          "FlowPackageViewerPage",
          "lib/flows/package-content.ts#listInstalledPackageFiles",
          "wrapper",
        ],
        [
          "FlowPackageViewerPage",
          "lib/flows/package-content.ts#readInstalledPackageFile",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "app/(app)/studio/packages/[ref]/agents/[stem]/page.tsx",
      "manager-flow-state",
      "pages rendering installed package content through the confined package-content readers",
      [
        [
          "StudioAgentDetailPage",
          "lib/flows/package-content.ts#readInstalledPackageFile",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "app/(app)/studio/packages/[ref]/skills/[...path]/page.tsx",
      "manager-flow-state",
      "pages rendering installed package content through the confined package-content readers",
      [
        [
          "StudioSkillDetailPage",
          "lib/flows/package-content.ts#listInstalledPackageFiles",
          "wrapper",
        ],
        [
          "StudioSkillDetailPage",
          "lib/flows/package-content.ts#readInstalledPackageFile",
          "wrapper",
        ],
        [
          "StudioSkillDetailPage",
          "lib/flows/package-content.ts#readInstalledPackageImage",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "app/(app)/studio/packages/[ref]/subagents/[stem]/page.tsx",
      "manager-flow-state",
      "pages rendering installed package content through the confined package-content readers",
      [
        [
          "StudioSubagentDetailPage",
          "lib/flows/package-content.ts#listInstalledPackageFiles",
          "wrapper",
        ],
        [
          "StudioSubagentDetailPage",
          "lib/flows/package-content.ts#readInstalledPackageFile",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "app/api/admin/agents/[agentId]/route.ts",
      "repository-worktree",
      "agent definition re-sync from the package checkout",
      [["GET", "node:fs/promises.readFile", "read"]],
    ),
    ...classified(
      "app/api/projects/route.ts",
      "repository-worktree",
      "project registration reads maister.yaml from the operator-supplied checkout path",
      [
        ["pathExists", "node:fs/promises.stat", "stat"],
        [
          "removeUnchangedBootstrapMaisterYaml",
          "node:fs/promises.readFile",
          "read",
        ],
        [
          "removeUnchangedBootstrapMaisterYaml",
          "node:fs/promises.rm",
          "remove",
        ],
        ["POST", "node:fs/promises.rm", "remove"],
        ["register", "node:fs/promises.rm", "remove"],
        ["bootstrapMaisterYaml", "lib/atomic.ts#atomicWriteText", "wrapper"],
        ["register", "lib/config.ts#loadProjectConfig", "wrapper"],
        ["register", "lib/repo-source.ts#gitInit", "wrapper"],
      ],
    ),
    ...classified(
      "lib/agents/dirty-watchdog.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["fileExists", "node:fs/promises.stat", "stat"],
        ["<object>.materialize", "lib/atomic.ts#atomicWriteText", "wrapper"],
      ],
    ),
    ...classified(
      "lib/agents/effective.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        [
          "resolveEffectiveAgentDefinition",
          "node:fs/promises.readFile",
          "read",
        ],
      ],
    ),
    ...classified(
      "lib/agents/facade-launch.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["resolveFacadeLaunch", "node:fs.existsSync", "stat"]],
    ),
    ...classified(
      "lib/agents/finalization.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["pathIsDirectory", "node:fs/promises.stat", "stat"],
        [
          "afterCommit",
          "lib/gc/plain-agent-directory-gc.ts#removeOwnedPlainAgentDirectory",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/agents/flow-binding.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["resolveFlowBoundAgent", "node:fs/promises.readFile", "read"]],
    ),
    ...classified(
      "lib/agents/launch.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["packageSkillMaterializationRoots", "node:fs/promises.stat", "stat"],
        ["launchAgentRun", "node:fs/promises.mkdir", "write"],
        ["startAgentSession", "node:fs/promises.mkdir", "write"],
        [
          "applyAgentMemoryForLaunch",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/agents/materialization-lock.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["assertSafeDirectory", "node:fs/promises.lstat", "stat"],
        ["assertSafeMutexFiles", "node:fs/promises.lstat", "stat"],
        ["tryAcquireMaterializationLock", "node:sqlite.DatabaseSync", "sqlite"],
      ],
    ),
    ...classified(
      "lib/agents/materialization-manifest.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["readIndex", "node:fs/promises.readFile", "read"],
        ["assertNoSymlinkComponents", "node:fs/promises.lstat", "stat"],
        ["resolveSafeMaterializationCwd", "node:fs/promises.realpath", "stat"],
        ["withLock", "node:fs/promises.mkdir", "write"],
        ["readRunRecord", "node:fs/promises.readFile", "read"],
        ["assertSafeOwnedTarget", "node:fs/promises.lstat", "stat"],
        ["releaseAgentMaterialization", "node:fs/promises.rm", "remove"],
        ["listAgentMaterializationRunIds", "node:fs/promises.readdir", "list"],
        [
          "materializeWithAgentLease",
          "lib/atomic.ts#atomicWriteJson",
          "wrapper",
        ],
        ["recordIntent", "lib/atomic.ts#atomicWriteJson", "wrapper"],
        [
          "releaseAgentMaterialization",
          "lib/atomic.ts#atomicWriteJson",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/agents/memory-store.ts",
      "manager-flow-state",
      "per-attachment agent memory under .maister/<slug>/agents (ADR-152)",
      [
        ["readAgentMemoryRaw", "node:fs/promises.stat", "stat"],
        ["readAgentMemoryRaw", "node:fs/promises.readFile", "read"],
        ["clearAgentMemoryCas", "node:fs/promises.unlink", "remove"],
        ["writeAgentMemory", "node:fs/promises.stat", "stat"],
        ["writeAgentMemory", "lib/atomic.ts#atomicWriteText", "wrapper"],
      ],
    ),
    ...classified(
      "lib/agents/registry.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["listAgentFileStems", "node:fs/promises.readdir", "list"],
        ["registerPackageAgents", "node:fs/promises.readFile", "read"],
      ],
    ),
    ...classified(
      "lib/atomic.ts",
      "manager-flow-state",
      "tmp+rename writer for manager-owned JSON/text; every caller decides the location and is inventoried",
      [
        ["atomicWriteText", "node:fs/promises.mkdir", "write"],
        ["atomicWriteText", "node:fs/promises.writeFile", "write"],
        ["atomicWriteText", "node:fs/promises.rename", "write"],
        ["atomicWriteText", "node:fs/promises.unlink", "remove"],
        ["atomicWriteBuffer", "node:fs/promises.mkdir", "write"],
        ["atomicWriteBuffer", "node:fs/promises.open", "open"],
        ["atomicWriteBuffer", "node:fs/promises.rename", "write"],
        ["atomicWriteBuffer", "node:fs/promises.unlink", "remove"],
      ],
    ),
    ...classified(
      "lib/auto-promotion/readers.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["showFileAtRef", "node:child_process.execFile", "spawn", "git"]],
    ),
    ...classified(
      "lib/capabilities/adapter-home.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["pathExists", "node:fs/promises.lstat", "stat"],
        ["findOwnedAdapterHome", "node:fs/promises.lstat", "stat"],
        ["<object>.materialize", "node:fs/promises.mkdir", "write"],
        ["<object>.materialize", "node:fs/promises.lstat", "stat"],
        ["listDir", "node:fs/promises.readdir", "list"],
        ["composeCodexHome", "node:fs/promises.rm", "remove"],
        ["composeCodexHome", "node:fs/promises.symlink", "write"],
        ["composeCodexHome", "node:fs/promises.mkdir", "write"],
        ["copyBundleSkills", "node:fs/promises.mkdir", "write"],
        ["copyBundleSkills", "node:fs/promises.rm", "remove"],
        ["copyBundleSkills", "node:fs/promises.cp", "write"],
        ["copyBundleAgents", "node:fs/promises.mkdir", "write"],
        ["copyBundleAgents", "node:fs/promises.cp", "write"],
        ["materializeFlowAuthoringSkill", "node:fs/promises.mkdtemp", "write"],
        ["materializeFlowAuthoringSkill", "node:fs/promises.mkdir", "write"],
        ["materializeFlowAuthoringSkill", "node:fs/promises.rm", "remove"],
        ["<object>.materialize", "lib/atomic.ts#atomicWriteText", "wrapper"],
        [
          "materializeFlowAuthoringSkill",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/capabilities/cleanup.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["cleanupNodeMaterialization", "node:fs/promises.rm", "unresolved"]],
    ),
    ...classified(
      "lib/capabilities/import.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["pathExists", "node:fs/promises.stat", "stat"],
        ["gitClone", "node:child_process.execFile", "spawn", "git"],
        ["gitRevParseHead", "node:child_process.execFile", "spawn", "git"],
        ["runSetupSh", "node:child_process.execFile", "spawn", "bash"],
        ["runSetupSh", "node:fs/promises.writeFile", "write"],
        ["installCapabilityRevision", "node:fs/promises.mkdtemp", "write"],
        ["installCapabilityRevision", "node:fs/promises.rm", "remove"],
        ["installCapabilityRevision", "node:fs/promises.mkdir", "write"],
        ["installCapabilityRevision", "node:fs/promises.cp", "write"],
        ["installCapabilityRevision", "node:fs/promises.rename", "write"],
      ],
    ),
    ...classified(
      "lib/capabilities/materialize-bundle.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["pathExists", "node:fs/promises.stat", "stat"],
        ["copyBundleArtifactsToWorktree", "node:fs/promises.mkdir", "write"],
        ["copyBundleArtifactsToWorktree", "node:fs/promises.readdir", "list"],
        ["copyBundleArtifactsToWorktree", "node:fs/promises.cp", "write"],
        ["skipWorktree", "node:child_process.execFile", "spawn", "git"],
        ["writeAiFactoryConfigOverride", "node:fs/promises.readFile", "read"],
        ["writeAiFactoryConfigOverride", "node:fs/promises.mkdir", "write"],
        ["ensureWorktreeGitignore", "node:fs/promises.readFile", "read"],
        [
          "writeAiFactoryConfigOverride",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        ["ensureWorktreeGitignore", "lib/atomic.ts#atomicWriteText", "wrapper"],
      ],
    ),
    ...classified(
      "lib/capabilities/materialize.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["fileExists", "node:fs/promises.stat", "stat"],
        [
          "ensureWorktreeGitExclude",
          "node:child_process.execFile",
          "spawn",
          "git",
        ],
        ["ensureWorktreeGitExclude", "node:fs/promises.readFile", "read"],
        ["ensureWorktreeGitExclude", "node:fs/promises.mkdir", "write"],
        ["ensureWorktreeGitExclude", "node:fs/promises.appendFile", "write"],
        ["<object>.materialize", "node:fs/promises.mkdir", "write"],
        ["<object>.materialize", "lib/atomic.ts#atomicWriteJson", "wrapper"],
        ["<object>.materialize", "lib/atomic.ts#atomicWriteText", "wrapper"],
      ],
    ),
    ...classified(
      "lib/capabilities/settings-ownership.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["pathExists", "node:fs/promises.lstat", "stat"],
        ["readSettingsOwnerAtCwd", "node:fs/promises.readFile", "read"],
        [
          "readCapabilitySettingsOperationAtCwd",
          "node:fs/promises.readFile",
          "read",
        ],
        [
          "clearCapabilitySettingsLifecycleAtCwd",
          "node:fs/promises.rm",
          "remove",
        ],
        [
          "recoverInterruptedCapabilitySettingsAtCwd",
          "node:fs/promises.rm",
          "remove",
        ],
        [
          "recoverInterruptedCapabilitySettingsAtCwd",
          "node:fs/promises.readFile",
          "read",
        ],
        [
          "reclaimOwnedCapabilitySettingsAtCwd",
          "node:fs/promises.readFile",
          "read",
        ],
        [
          "reclaimOwnedCapabilitySettingsAtCwd",
          "node:fs/promises.rm",
          "remove",
        ],
        ["<object>.materialize", "node:fs/promises.mkdir", "write"],
        ["<object>.materialize", "node:fs/promises.readFile", "read"],
        ["reclaimAgentL2Settings", "node:fs/promises.rm", "remove"],
        [
          "writeCapabilitySettingsOperationAtCwd",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        [
          "recoverInterruptedCapabilitySettingsAtCwd",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        [
          "reclaimOwnedCapabilitySettingsAtCwd",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        ["<object>.materialize", "lib/atomic.ts#atomicWriteText", "wrapper"],
      ],
    ),
    ...classified(
      "lib/catalog/seed-from-revision.ts",
      "manager-flow-state",
      "manager-owned package manifests, BOM and result-export schema reads through the config/package loaders",
      [
        [
          "readForkBundle",
          "lib/flows/package-authoring.ts#readAuthoredFlowPackageDirectory",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/config.ts",
      "manager-flow-state",
      "maister.yaml / flow.yaml / package manifests and the system flow cache under ~/.maister and .maister/<slug>/flows",
      [
        ["loadProjectConfig", "node:fs/promises.readFile", "read"],
        ["loadFlowManifest", "node:fs/promises.readFile", "read"],
        ["readFormSchemaDocWithBytes", "node:fs/promises.realpath", "stat"],
        ["readFormSchemaDocWithBytes", "node:fs/promises.readFile", "read"],
      ],
    ),
    ...classified(
      "lib/context-mounts/terminal.ts",
      "manager-flow-state",
      "read-only sibling-repo context mounts materialized under the run dir (ADR-157)",
      [["checkContextMountDirt", "node:fs/promises.stat", "stat"]],
    ),
    ...classified(
      "lib/db/check-migrations.ts",
      "migration-tooling",
      "Drizzle migration ledger and journal files under web/lib/db; read by the operator migration CLI and verified (never applied) at boot",
      [
        ["readJournalTags", "node:fs.readFileSync", "read"],
        ["findMainMigrationJournalEntry", "node:fs.readFileSync", "read"],
        ["migrationHash", "node:fs.readFileSync", "read"],
        ["findPendingBrainMigrations", "node:fs.existsSync", "stat"],
      ],
      {
        authority:
          "operator CLI: pnpm db:migrate / db:check (and the boot-time ledger check, which only reads)",
        lifetime:
          "for as long as the Drizzle journal is the migration source of truth",
      },
    ),
    ...classified(
      "lib/db/m43-cutover-migration-root.ts",
      "migration-tooling",
      "Drizzle migration ledger and journal files under web/lib/db; read by the operator migration CLI and verified (never applied) at boot",
      [
        ["createMigrationRootBefore", "node:fs/promises.readFile", "read"],
        ["createMigrationRootBefore", "node:fs/promises.mkdtemp", "write"],
        ["createMigrationRootBefore", "node:fs/promises.mkdir", "write"],
        ["createMigrationRootBefore", "node:fs/promises.copyFile", "write"],
        ["createMigrationRootBefore", "node:fs/promises.writeFile", "write"],
        ["createMigrationRootBefore", "node:fs/promises.rm", "remove"],
      ],
      {
        authority:
          "operator CLI: pnpm db:migrate / db:check (and the boot-time ledger check, which only reads)",
        lifetime:
          "for as long as the Drizzle journal is the migration source of truth",
      },
    ),
    ...classified(
      "lib/db/migrate.ts",
      "migration-tooling",
      "Drizzle migration ledger and journal files under web/lib/db; read by the operator migration CLI and verified (never applied) at boot",
      [["main", "node:fs/promises.rm", "remove"]],
      {
        authority:
          "operator CLI: pnpm db:migrate / db:check (and the boot-time ledger check, which only reads)",
        lifetime:
          "for as long as the Drizzle journal is the migration source of truth",
      },
    ),
    ...classified(
      "lib/evaluations/evidence/store.ts",
      "manager-evidence",
      "manager-owned Evaluation Lab evidence store under MAISTER_EVALUATION_EVIDENCE_ROOT",
      [
        ["readEvidenceBlob", "node:fs/promises.open", "open"],
        ["writeEvidenceBlob", "lib/atomic.ts#atomicWriteBuffer", "wrapper"],
      ],
    ),
    ...classified(
      "lib/evaluations/method.ts",
      "manager-evidence",
      "manager-owned Evaluation Lab evidence store under MAISTER_EVALUATION_EVIDENCE_ROOT",
      [["loadEvaluationMethod", "node:fs/promises.readFile", "read"]],
    ),
    ...classified(
      "lib/evaluations/preflight-loaders.ts",
      "manager-evidence",
      "manager-owned Evaluation Lab evidence store under MAISTER_EVALUATION_EVIDENCE_ROOT",
      [
        [
          "buildFlowContractProjection",
          "lib/config.ts#readAndValidateFormSchemaDoc",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/execution-host/adoption.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["pathIsDirectory", "node:fs/promises.stat", "stat"]],
    ),
    ...classified(
      "lib/execution-host/capability-profile.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["readCapabilityFile", "node:fs/promises.readFile", "read"]],
    ),
    ...classified(
      "lib/flows.ts",
      "manager-flow-state",
      "maister.yaml / flow.yaml / package manifests and the system flow cache under ~/.maister and .maister/<slug>/flows",
      [
        ["pathExists", "node:fs/promises.stat", "stat"],
        ["readSchemaDirectoryFiles", "node:fs/promises.lstat", "stat"],
        ["visit", "node:fs/promises.readdir", "list"],
        ["visit", "node:fs/promises.readFile", "read"],
        ["repairPackageRootSchemaCache", "node:fs/promises.rm", "remove"],
        ["repairPackageRootSchemaCache", "node:fs/promises.mkdir", "write"],
        ["repairPackageRootSchemaCache", "node:fs/promises.writeFile", "write"],
        [
          "materializeSharedPackageRootSchemas",
          "node:fs/promises.mkdir",
          "write",
        ],
        [
          "materializeSharedPackageRootSchemas",
          "node:fs/promises.writeFile",
          "write",
        ],
        ["gitClone", "node:child_process.execFile", "spawn", "git"],
        ["ensureSymlink", "node:fs/promises.mkdir", "write"],
        ["ensureSymlink", "node:fs/promises.lstat", "stat"],
        ["ensureSymlink", "node:fs/promises.symlink", "write"],
        ["ensureSymlink", "node:fs/promises.readlink", "read"],
        ["ensureSymlink", "node:fs/promises.unlink", "remove"],
        ["runSetupSh", "node:child_process.execFile", "spawn", "bash"],
        ["runSetupSh", "node:fs/promises.writeFile", "write"],
        ["gitRevParseHead", "node:child_process.execFile", "spawn", "git"],
        ["isLocalDirectorySource", "node:fs/promises.stat", "stat"],
        ["walk", "node:fs/promises.readdir", "list"],
        ["walk", "node:fs/promises.readlink", "read"],
        ["walk", "node:fs/promises.readFile", "read"],
        ["installRevision", "node:fs/promises.mkdtemp", "write"],
        ["installRevision", "node:fs/promises.rm", "remove"],
        ["installRevision", "node:fs/promises.mkdir", "write"],
        ["installRevision", "node:fs/promises.cp", "write"],
        ["installRevision", "node:fs/promises.rename", "write"],
        [
          "validatePackageRootSchemaReferences",
          "lib/config.ts#readAndValidateFormSchemaDoc",
          "wrapper",
        ],
        ["loadManifestOrThrow", "lib/config.ts#loadFlowManifest", "wrapper"],
        [
          "installAuthoredFlowPackageBridge",
          "lib/flows/package-authoring.ts#readAuthoredFlowPackageDirectory",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/flows/authored-bridge.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["bridgePublishedAuthoredFlow", "node:fs/promises.mkdtemp", "write"],
        ["bridgePublishedAuthoredFlow", "node:fs/promises.rm", "remove"],
        [
          "bridgePublishedAuthoredFlow",
          "lib/flows/package-authoring.ts#writeAuthoredFlowPackageDirectory",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/flows/graph/action-completion.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        [
          "persistLocalActionCompletion",
          "lib/flows/graph/node-output.ts#readCliOutputFile",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/flows/graph/artifact-content.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["readBounded", "node:fs/promises.open", "open"],
        ["resolveFile", "node:fs/promises.realpath", "stat"],
        ["resolveFile", "node:fs/promises.readFile", "read"],
      ],
    ),
    ...classified(
      "lib/flows/graph/consensus/runtime.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["readConsensusHumanDecision", "node:fs/promises.readFile", "read"],
        ["consumeConsensusHumanDecision", "node:fs/promises.unlink", "remove"],
        ["createConsensusHitl", "node:fs/promises.unlink", "remove"],
        ["createConsensusHitl", "lib/atomic.ts#atomicWriteJson", "wrapper"],
      ],
    ),
    ...classified(
      "lib/flows/graph/gates-exec.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        [
          "runMutationAssertionGate",
          "lib/flows/graph/mutation-check.ts#readNodeStartHead",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/flows/graph/mutation-check.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["touchedPaths", "node:child_process.execFile", "spawn", "git"],
        ["captureNodeStartHead", "node:fs/promises.access", "stat"],
        ["readNodeStartHead", "node:fs/promises.readFile", "read"],
        ["captureNodeStartHead", "lib/atomic.ts#atomicWriteJson", "wrapper"],
      ],
    ),
    ...classified(
      "lib/flows/graph/node-output.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["readCliOutputFile", "node:fs/promises.stat", "stat"],
        ["readCliOutputFile", "node:fs/promises.readFile", "read"],
        [
          "validateNodeStructuredOutput",
          "lib/config.ts#resolveOutputResultSchemaWithIdentity",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/flows/graph/run-context.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        [
          "isRunContextWriteSafe",
          "node:child_process.execFile",
          "spawn",
          "git",
        ],
        ["writeRunContext", "lib/atomic.ts#atomicWriteJson", "wrapper"],
      ],
    ),
    ...classified(
      "lib/flows/graph/runner-graph.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["tryReadInputArtifact", "node:fs/promises.readFile", "read"],
        ["escalateAutoRetryExhaustion", "node:fs/promises.unlink", "remove"],
        ["runReviewHuman", "node:fs/promises.unlink", "remove"],
        ["runFormCollect", "node:fs/promises.unlink", "remove"],
        ["runGraph", "node:fs/promises.stat", "stat"],
        [
          "escalateAutoRetryExhaustion",
          "lib/atomic.ts#atomicWriteJson",
          "wrapper",
        ],
        ["runReviewHuman", "lib/atomic.ts#atomicWriteJson", "wrapper"],
        [
          "runFormCollect",
          "lib/config.ts#readAndValidateFormSchemaDoc",
          "wrapper",
        ],
        ["runFormCollect", "lib/atomic.ts#atomicWriteJson", "wrapper"],
        [
          "runGraph",
          "lib/flows/graph/mutation-check.ts#captureNodeStartHead",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/flows/graph/workspace-checkpoint.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["git", "node:child_process.execFile", "spawn", "git"],
        ["captureCheckpoint", "node:fs/promises.mkdtemp", "write"],
        ["captureCheckpoint", "node:fs/promises.rm", "remove"],
        ["deleteChatCheckpoint", "node:child_process.execFile", "spawn", "git"],
      ],
    ),
    ...classified(
      "lib/flows/lifecycle.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["removeRevision", "node:fs/promises.rm", "remove"],
        ["scanRevisionAgents", "node:fs/promises.readdir", "list"],
        ["scanRevisionAgents", "node:fs/promises.readFile", "read"],
        ["repointSymlink", "lib/flows.ts#ensureSymlink", "wrapper"],
      ],
    ),
    ...classified(
      "lib/flows/package-authoring.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        [
          "readAuthoredFlowPackageDirectory",
          "node:fs/promises.readFile",
          "read",
        ],
        [
          "writeAuthoredFlowPackageDirectory",
          "node:fs/promises.access",
          "stat",
        ],
        ["writeAuthoredFlowPackageDirectory", "node:fs/promises.rm", "remove"],
        [
          "writeAuthoredFlowPackageDirectory",
          "node:fs/promises.mkdir",
          "write",
        ],
        [
          "writeAuthoredFlowPackageDirectory",
          "node:fs/promises.writeFile",
          "write",
        ],
        [
          "writeAuthoredFlowPackageDirectory",
          "node:fs/promises.rename",
          "write",
        ],
        ["walk", "node:fs/promises.readdir", "list"],
        ["walk", "node:fs/promises.readFile", "read"],
      ],
    ),
    ...classified(
      "lib/flows/package-content.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["walk", "node:fs/promises.readdir", "list"],
        ["listInstalledPackageFiles", "node:fs/promises.stat", "stat"],
        ["listInstalledPackageFiles", "node:fs/promises.readFile", "read"],
        ["resolveConfinedFile", "node:fs/promises.realpath", "stat"],
        ["resolveConfinedFile", "node:fs/promises.stat", "stat"],
        ["readInstalledPackageFile", "node:fs/promises.readFile", "read"],
        ["readInstalledPackageImage", "node:fs/promises.readFile", "read"],
      ],
    ),
    ...classified(
      "lib/flows/requirements-check.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        [
          "checkFlowRequirements",
          "node:child_process.execFile",
          "spawn",
          "bash",
        ],
      ],
    ),
    ...classified(
      "lib/flows/result-profiles.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        [
          "resolveProfileDoc",
          "lib/config.ts#readFormSchemaDocWithBytes",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/flows/runner-cli.ts",
      "manager-flow-state",
      "flow-engine state the manager owns: installed package content, authored packages, run inputs/outputs under .maister/<slug>/runs",
      [
        ["execDetachedGroup", "node:child_process.spawn", "spawn", "bash"],
        ["runCliStep", "node:fs/promises.mkdir", "write"],
      ],
    ),
    ...classified(
      "lib/gc/agent-materialization-gc.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        [
          "discoverAgentMaterializationCandidateRoots",
          "node:fs/promises.readdir",
          "list",
        ],
      ],
    ),
    ...classified(
      "lib/gc/context-mount-gc.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["readMarker", "node:fs/promises.readFile", "read"],
        ["listMountCandidates", "node:fs/promises.readdir", "list"],
        ["runContextMountGcSweep", "node:fs/promises.realpath", "stat"],
        ["runContextMountGcSweep", "node:fs/promises.rm", "remove"],
        ["isRegisteredWorktree", "node:fs/promises.realpath", "stat"],
        ["recordAttemptFailure", "lib/atomic.ts#atomicWriteJson", "wrapper"],
      ],
    ),
    ...classified(
      "lib/gc/ephemeral-agent-gc.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["runEphemeralAgentGcSweep", "node:fs/promises.readdir", "list"]],
    ),
    ...classified(
      "lib/gc/plain-agent-directory-gc.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["removeOwnedPlainAgentDirectory", "node:fs/promises.realpath", "stat"],
        ["removeOwnedPlainAgentDirectory", "node:fs/promises.lstat", "stat"],
        ["removeOwnedPlainAgentDirectory", "node:fs/promises.rm", "remove"],
      ],
    ),
    ...classified(
      "lib/gc/preserve.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["git", "node:child_process.execFile", "spawn", "git"]],
    ),
    ...classified(
      "lib/gc/revision-gc.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["runRevisionGcSweep", "node:fs/promises.rm", "unresolved"]],
    ),
    ...classified(
      "lib/gc/workspace-gc.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["defaultWorktreeExists", "node:fs/promises.access", "stat"]],
    ),
    ...classified(
      "lib/gc/workspace-reconciler.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["listCandidates", "node:fs/promises.realpath", "stat"],
        ["listCandidates", "node:fs/promises.readdir", "list"],
        ["listCandidates", "node:fs/promises.lstat", "stat"],
        ["listMissingWorkspaceCandidates", "node:fs/promises.realpath", "stat"],
        ["listMissingWorkspaceCandidates", "node:fs/promises.lstat", "stat"],
        ["loadTrustedProject", "node:fs/promises.realpath", "stat"],
        [
          "runWorkspaceReconciliationSweep",
          "node:fs/promises.realpath",
          "stat",
        ],
      ],
    ),
    ...classified(
      "lib/instance-config.ts",
      "manager-flow-state",
      "maister.yaml / flow.yaml / package manifests and the system flow cache under ~/.maister and .maister/<slug>/flows",
      [["probeTool", "node:child_process.execFile", "spawn", null]],
    ),
    ...classified(
      "lib/local-packages/bom.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["localPackageSource", "node:fs/promises.readFile", "read"],
        [
          "localPackageSource",
          "lib/flows/package-content.ts#listInstalledPackageFiles",
          "wrapper",
        ],
        [
          "localPackageSource.readFile",
          "lib/flows/package-content.ts#readInstalledPackageFile",
          "wrapper",
        ],
        [
          "localPackageSource.loadFlow",
          "lib/flows/package-content.ts#resolveConfinedFlowYaml",
          "wrapper",
        ],
        [
          "localPackageSource.loadFlow",
          "lib/config.ts#loadFlowManifest",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/local-packages/create-flow-operation.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["writeCreationJournal", "node:fs/promises.mkdir", "write"],
        ["readCreationJournal", "node:fs/promises.readFile", "read"],
        ["removeCreationJournal", "node:fs/promises.rm", "remove"],
        ["writeCreationJournal", "lib/atomic.ts#atomicWriteText", "wrapper"],
      ],
    ),
    ...classified(
      "lib/local-packages/divergence.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["loadInstallDir", "node:fs/promises.stat", "stat"],
        [
          "computeUpstreamDivergence",
          "lib/local-packages/git.ts#gitDiffNoIndex",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/local-packages/fork.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["loadInstallSource", "node:fs/promises.stat", "stat"],
        ["loadSourceElement", "node:fs/promises.stat", "stat"],
        ["copyElementInto", "node:fs/promises.mkdir", "write"],
        ["copyElementInto", "node:fs/promises.cp", "write"],
        [
          "forkPackageToLocal",
          "lib/local-packages/git.ts#gitInitWithCommit",
          "wrapper",
        ],
        [
          "loadSourceElement",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
        [
          "copyElementInto",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/local-packages/git.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["git", "node:child_process.execFile", "spawn", "git"],
        [
          "ensureLocalPackageGitExclude",
          "node:child_process.execFile",
          "spawn",
          "git",
        ],
        ["ensureLocalPackageGitExclude", "node:fs/promises.readFile", "read"],
        ["ensureLocalPackageGitExclude", "node:fs/promises.mkdir", "write"],
        ["ensureLocalPackageGitExclude", "node:fs/promises.writeFile", "write"],
        ["gitHeadSha", "node:child_process.execFile", "spawn", "git"],
        [
          "gitRemoteDefaultBranch",
          "node:child_process.execFile",
          "spawn",
          "git",
        ],
        ["gitMergeFile", "node:child_process.execFile", "spawn", "git"],
        ["gitDiffNoIndex", "node:child_process.execFile", "spawn", "git"],
      ],
    ),
    ...classified(
      "lib/local-packages/import.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["commitImport", "node:fs/promises.mkdir", "write"],
        [
          "planImport",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
        [
          "commitImport",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
        ["commitImport", "lib/atomic.ts#atomicWriteBuffer", "wrapper"],
      ],
    ),
    ...classified(
      "lib/local-packages/paths.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["resolveWithinWorkingDir", "node:fs/promises.realpath", "stat"]],
    ),
    ...classified(
      "lib/local-packages/service.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["claimLocalPackageWorkingDir", "node:fs/promises.mkdir", "write"],
        ["removeOwnedLocalPackageWorkingDir", "node:fs/promises.rm", "remove"],
        ["claimInitialCreationStagingDir", "node:fs/promises.mkdir", "write"],
        ["scaffoldWorkingDir", "node:fs/promises.mkdir", "write"],
        ["readTextIfPresent", "node:fs/promises.readFile", "read"],
        ["pathExists", "node:fs/promises.lstat", "stat"],
        ["materializeInitialFlow", "node:fs/promises.mkdir", "write"],
        ["materializeInitialFlow", "node:fs/promises.rename", "write"],
        ["materializeAdditionalFlow", "node:fs/promises.mkdir", "write"],
        ["compensateFailedInitialCreation", "node:fs/promises.rm", "remove"],
        [
          "compensateUnjournaledInitialCreation",
          "node:fs/promises.rm",
          "remove",
        ],
        ["compensateFailedAdditionalFlow", "node:fs/promises.rm", "remove"],
        ["cleanCopyExcludingGit", "node:fs/promises.mkdir", "write"],
        ["cleanCopyExcludingGit", "node:fs/promises.cp", "write"],
        ["<object>.filter", "node:fs/promises.lstat", "stat"],
        ["exportWorkingDir", "node:fs/promises.mkdtemp", "write"],
        ["deleteLocalPackage", "node:fs/promises.rm", "remove"],
        ["walk", "node:fs/promises.readdir", "list"],
        ["readFileContent", "node:fs/promises.readFile", "read"],
        ["writeWorkingDirFile", "node:fs/promises.mkdir", "write"],
        ["registerFlowElementInManifest", "node:fs/promises.readFile", "read"],
        ["deleteWorkingDirFile", "node:fs/promises.rm", "remove"],
        ["readWorkingDirArtifactFiles", "node:fs/promises.readFile", "read"],
        ["scaffoldWorkingDir", "lib/atomic.ts#atomicWriteText", "wrapper"],
        [
          "materializeInitialFlow",
          "lib/local-packages/git.ts#gitHeadSha",
          "wrapper",
        ],
        ["materializeInitialFlow", "lib/atomic.ts#atomicWriteText", "wrapper"],
        [
          "materializeInitialFlow",
          "lib/local-packages/git.ts#gitInitWithCommit",
          "wrapper",
        ],
        [
          "materializeAdditionalFlow",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        [
          "compensateFailedAdditionalFlow",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        [
          "createLocalPackage",
          "lib/local-packages/git.ts#gitInitWithCommit",
          "wrapper",
        ],
        [
          "ensureDefaultLocalPackage",
          "lib/local-packages/git.ts#gitInitWithCommit",
          "wrapper",
        ],
        [
          "readFileContent",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
        [
          "writeWorkingDirFile",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
        ["writeWorkingDirFile", "lib/atomic.ts#atomicWriteText", "wrapper"],
        [
          "registerFlowElementInManifest",
          "lib/config.ts#loadFlowManifest",
          "wrapper",
        ],
        [
          "registerFlowElementInManifest",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        [
          "deleteWorkingDirFile",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
        [
          "readWorkingDirArtifactFiles",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
        [
          "discardWorkingDir",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/local-packages/sync-merge.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["walkFiles", "node:fs/promises.readdir", "list"],
        ["readIfExists", "node:fs/promises.readFile", "read"],
        ["assertDir", "node:fs/promises.stat", "stat"],
        ["mergeTrees", "node:fs/promises.rm", "remove"],
        ["mergeTrees", "node:fs/promises.mkdir", "write"],
        ["mergeTrees", "node:fs/promises.writeFile", "write"],
        ["mergeTrees", "node:fs/promises.mkdtemp", "write"],
        ["mergeTrees", "lib/local-packages/git.ts#gitMergeFile", "wrapper"],
      ],
    ),
    ...classified(
      "lib/local-packages/sync.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["resolveSync", "node:fs/promises.readFile", "read"]],
    ),
    ...classified(
      "lib/local-packages/versions.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["cutLocalPackageVersion", "node:fs/promises.rm", "remove"],
        [
          "cutLocalPackageVersion",
          "lib/local-packages/git.ts#gitHeadSha",
          "wrapper",
        ],
        [
          "detectAvailablePackageVersions",
          "lib/local-packages/git.ts#gitHeadSha",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/packages/attach.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["pathExists", "node:fs/promises.stat", "stat"],
        ["collectInventory", "node:fs/promises.readdir", "list"],
        ["installPackageRevision", "node:fs/promises.rm", "remove"],
        ["installPackageRevision", "node:fs/promises.cp", "write"],
        ["installPackageRevision", "lib/config.ts#loadFlowManifest", "wrapper"],
      ],
    ),
    ...classified(
      "lib/packages/catalog.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["assertValidLocalPackageSourcePath", "node:fs/promises.stat", "stat"],
        ["isFile", "node:fs/promises.stat", "stat"],
        ["listPackageDirsWithManifest", "node:fs/promises.readdir", "list"],
        ["lsRemoteTags", "node:child_process.execFile", "spawn", "git"],
        ["scanDefaultBranchManifests", "node:fs/promises.mkdtemp", "write"],
        [
          "scanDefaultBranchManifests",
          "node:child_process.execFile",
          "spawn",
          "git",
        ],
        ["scanDefaultBranchManifests", "node:fs/promises.readdir", "list"],
        ["scanDefaultBranchManifests", "node:fs/promises.rm", "remove"],
        [
          "scanDefaultBranchManifests",
          "lib/packages/manifest.ts#loadMaisterPackageManifest",
          "wrapper",
        ],
        [
          "discoverLocalSourcePackages",
          "lib/packages/manifest.ts#loadMaisterPackageManifest",
          "wrapper",
        ],
        [
          "discoverLocalSourcePackages",
          "lib/flows.ts#localDirectoryContentDigest",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/packages/install.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["resolvePackageSource", "node:fs/promises.stat", "stat"],
        ["resolvePackageSource", "node:fs/promises.mkdtemp", "write"],
        ["cleanup", "node:fs/promises.rm", "remove"],
        [
          "resolvePackageSource",
          "lib/packages/manifest.ts#loadMaisterPackageManifest",
          "wrapper",
        ],
        [
          "resolvePackageSource",
          "lib/flows.ts#localDirectoryContentDigest",
          "wrapper",
        ],
        ["resolvePackageSource", "lib/flows.ts#gitClone", "wrapper"],
        ["resolvePackageSource", "lib/flows.ts#gitRevParseHead", "wrapper"],
        ["installPackage", "lib/config.ts#loadFlowManifest", "wrapper"],
      ],
    ),
    ...classified(
      "lib/packages/manifest.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["loadMaisterPackageManifest", "node:fs/promises.readFile", "read"]],
    ),
    ...classified(
      "lib/packages/yaml-writeback.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        ["writeBackPackagesPin", "node:fs/promises.readFile", "read"],
        ["writeBackPackagesPin", "lib/atomic.ts#atomicWriteText", "wrapper"],
      ],
    ),
    ...classified(
      "lib/persist-config.ts",
      "manager-flow-state",
      "maister.yaml / flow.yaml / package manifests and the system flow cache under ~/.maister and .maister/<slug>/flows",
      [
        ["pathExists", "node:fs/promises.stat", "stat"],
        ["persistProjectConfig", "node:fs/promises.unlink", "remove"],
        ["persistProjectConfig", "lib/atomic.ts#atomicWriteText", "wrapper"],
      ],
    ),
    ...classified(
      "lib/queries/package-bom.ts",
      "manager-flow-state",
      "manager-owned package manifests, BOM and result-export schema reads through the config/package loaders",
      [
        [
          "installedPackageSource.listFiles",
          "lib/flows/package-content.ts#listInstalledPackageFiles",
          "wrapper",
        ],
        [
          "installedPackageSource.readFile",
          "lib/flows/package-content.ts#readInstalledPackageFile",
          "wrapper",
        ],
        [
          "installedPackageSource.loadFlow",
          "lib/flows/package-content.ts#resolveConfinedFlowYaml",
          "wrapper",
        ],
        [
          "installedPackageSource.loadFlow",
          "lib/config.ts#loadFlowManifest",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/queries/packages.ts",
      "manager-flow-state",
      "manager-owned package manifests, BOM and result-export schema reads through the config/package loaders",
      [
        [
          "assessPackageCompatibility",
          "lib/config.ts#loadFlowManifest",
          "wrapper",
        ],
        [
          "getStudioPackageFlowGraphs",
          "lib/flows/package-content.ts#resolveConfinedFlowYaml",
          "wrapper",
        ],
        [
          "getStudioPackageFlowGraphs",
          "lib/config.ts#loadFlowManifest",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/repo-source.ts",
      "repository-worktree",
      "git/worktree operations the manager keeps until the Stage C repository cut",
      [
        ["assertGitAvailable", "node:child_process.execFile", "spawn", "git"],
        ["runGhAuthToken", "node:child_process.execFile", "spawn", "gh"],
        ["cloneRepo", "node:fs/promises.mkdtemp", "write"],
        ["cloneRepo", "node:fs/promises.writeFile", "write"],
        ["cloneRepo", "node:child_process.execFile", "spawn", "git"],
        ["cloneRepo", "node:fs/promises.rm", "remove"],
        ["readRemoteOrigin", "node:child_process.execFile", "spawn", "git"],
        ["isGitRepo", "node:child_process.execFile", "spawn", "git"],
        ["gitInit", "node:child_process.execFile", "spawn", "git"],
        ["pathExists", "node:fs/promises.stat", "stat"],
        ["resolveProjectSource", "node:fs/promises.mkdir", "write"],
        ["resolveProjectSource", "node:fs/promises.rm", "remove"],
      ],
    ),
    ...classified(
      "lib/run-results/flow-export.ts",
      "manager-flow-state",
      "manager-owned package manifests, BOM and result-export schema reads through the config/package loaders",
      [
        [
          "resolveFlowExportContract",
          "lib/config.ts#readFormSchemaDocWithBytes",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/runs/hook-trip.ts",
      "manager-flow-state",
      "needs-input.json and run-input artifacts the runner reads, under the web's MAISTER_RUNTIME_ROOT/.maister/<slug>/runs",
      [
        ["escalateHookTrip", "node:fs/promises.unlink", "remove"],
        ["escalateHookTrip", "lib/atomic.ts#atomicWriteJson", "wrapper"],
      ],
    ),
    ...classified(
      "lib/runs/keepalive-sweeper.ts",
      "manager-flow-state",
      "needs-input.json and run-input artifacts the runner reads, under the web's MAISTER_RUNTIME_ROOT/.maister/<slug>/runs",
      [
        ["actBudgetEscalate", "node:fs/promises.unlink", "remove"],
        ["actBudgetEscalate", "lib/atomic.ts#atomicWriteJson", "wrapper"],
      ],
    ),
    ...classified(
      "lib/runs/node-interrupt.ts",
      "manager-flow-state",
      "needs-input.json and run-input artifacts the runner reads, under the web's MAISTER_RUNTIME_ROOT/.maister/<slug>/runs",
      [
        ["escalateNodeInterrupt", "node:fs/promises.unlink", "remove"],
        ["escalateNodeInterrupt", "lib/atomic.ts#atomicWriteJson", "wrapper"],
      ],
    ),
    ...classified(
      "lib/runs/pr-adapter.ts",
      "repository-worktree",
      "PR delivery through the provider CLIs (gh/glab) — Stage C delivery boundary",
      [
        ["CliPrAdapter.exec", "node:child_process.execFile", "spawn", null],
        ["githubPrState", "node:child_process.execFile", "spawn", "gh"],
        ["gitlabPrState", "node:child_process.execFile", "spawn", "glab"],
      ],
    ),
    ...classified(
      "lib/runs/promote.ts",
      "repository-worktree",
      "promotion writes its delivery record beside the run's manager state and drives the worktree merge — Stage C delivery boundary",
      [
        [
          "promotePullRequestSideEffect",
          "lib/repo-source.ts#readRemoteOrigin",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/scheduler/handlers/command.ts",
      "manager-flow-state",
      "scheduler console command jobs (fixed host tools with validated arguments)",
      [["consolePing", "node:child_process.execFile", "spawn", "ping"]],
    ),
    ...classified(
      "lib/scheduler/handlers/pr-state-scan.ts",
      "repository-worktree",
      "callers of worktree/PR wrappers — Stage C repository cut",
      [["runPrStateScanJob", "lib/repo-source.ts#readRemoteOrigin", "wrapper"]],
    ),
    ...classified(
      "lib/scheduler/handlers/repo-delivery-pr-history.ts",
      "repository-worktree",
      "PR history read through the provider CLIs (gh/glab) — Stage C delivery boundary",
      [
        ["readGitHubPullRequest", "node:child_process.execFile", "spawn", "gh"],
        [
          "readGitLabMergeRequest",
          "node:child_process.execFile",
          "spawn",
          "glab",
        ],
      ],
    ),
    ...classified(
      "lib/scratch-runs/local-package-materialization.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [
        [
          "cleanupLocalPackageAssistantMaterialization",
          "node:fs/promises.rm",
          "remove",
        ],
      ],
    ),
    ...classified(
      "lib/services/gate-chat-turn-completion.ts",
      "repository-worktree",
      "gate-chat L3 sense-and-restore of the run worktree — Stage C repository cut",
      [
        ["git", "node:child_process.execFile", "spawn", "git"],
        ["currentContentTree", "node:fs/promises.mkdtemp", "write"],
        ["currentContentTree", "node:fs/promises.rm", "remove"],
        ["senseAndRestore", "node:fs/promises.rm", "remove"],
      ],
    ),
    ...classified(
      "lib/services/gate-chat.ts",
      "repository-worktree",
      "gate-chat L3 sense-and-restore of the run worktree — Stage C repository cut",
      [["sendGateChatTurn", "node:child_process.execFile", "spawn", "git"]],
    ),
    ...classified(
      "lib/services/hitl.ts",
      "manager-flow-state",
      "form/HITL input artifacts (input-<step>.json) written for the runner under the web's runtime root",
      [
        [
          "reconcilePlanReviewDecisionHandoffs",
          "lib/atomic.ts#atomicWriteJson",
          "wrapper",
        ],
        [
          "handlePlanReviewDecisionResponse",
          "lib/atomic.ts#atomicWriteJson",
          "wrapper",
        ],
        [
          "handlePlanReviewParentResponse",
          "lib/atomic.ts#atomicWriteJson",
          "wrapper",
        ],
        ["handleFormHumanResponse", "lib/atomic.ts#atomicWriteJson", "wrapper"],
      ],
    ),
    ...classified(
      "lib/services/runs.ts",
      "manager-flow-state",
      "form/HITL input artifacts (input-<step>.json) written for the runner under the web's runtime root",
      [
        ["writeEvaluationFormInputs", "node:fs/promises.mkdir", "write"],
        [
          "writeEvaluationFormInputs",
          "lib/config.ts#readAndValidateFormSchemaDoc",
          "wrapper",
        ],
        [
          "writeEvaluationFormInputs",
          "lib/atomic.ts#atomicWriteJson",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/studio/flow-assistant/action-log.ts",
      "manager-flow-state",
      "Studio assistant action logs under the web's runtime root",
      [
        ["appendFlowAssistantActionLog", "node:fs/promises.mkdir", "write"],
        [
          "appendFlowAssistantActionLog",
          "node:fs/promises.appendFile",
          "write",
        ],
      ],
    ),
    ...classified(
      "lib/studio/flow-assistant/actions.ts",
      "manager-flow-state",
      "Studio assistant action logs under the web's runtime root",
      [
        [
          "validateActionPaths",
          "lib/local-packages/paths.ts#resolveWithinWorkingDir",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/studio/flow-detail.ts",
      "manager-flow-state",
      "Studio assistant action logs under the web's runtime root",
      [
        [
          "getStudioFlowDetail",
          "lib/flows/package-content.ts#readInstalledPackageFile",
          "wrapper",
        ],
        ["getStudioFlowDetail", "lib/config.ts#loadFlowManifest", "wrapper"],
      ],
    ),
    ...classified(
      "lib/workbench-lifecycle/service.ts",
      "repository-worktree",
      "worktree, repository, package and capability materialization on the shared checkout — Stage C repository cut",
      [["worktreeExists", "node:fs/promises.access", "stat"]],
    ),
    ...classified(
      "lib/worktree-provenance.ts",
      "repository-worktree",
      "git/worktree operations the manager keeps until the Stage C repository cut",
      [
        ["runGit", "node:child_process.execFile", "spawn", "git"],
        [
          "assertManagedFilesExcluded",
          "node:child_process.execFile",
          "spawn",
          "git",
        ],
        ["writeManagedHookAndTemplate", "node:fs/promises.chmod", "write"],
        ["ensureWorktreeProvenance", "node:fs/promises.readFile", "read"],
        [
          "readWorktreeProvenanceForPromotion",
          "node:fs/promises.access",
          "stat",
        ],
        ["readWorktreeProvenanceMetadata", "node:fs/promises.readFile", "read"],
        [
          "writeManagedHookAndTemplate",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        [
          "installWorktreeProvenance",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        [
          "ensureWorktreeProvenance",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        [
          "setWorktreeProvenanceNode",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
        [
          "clearWorktreeProvenanceNode",
          "lib/atomic.ts#atomicWriteText",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "lib/worktree.ts",
      "repository-worktree",
      "git/worktree operations the manager keeps until the Stage C repository cut",
      [
        ["runGit", "node:child_process.execFile", "spawn", "git"],
        ["pushBranch", "node:child_process.execFile", "spawn", "git"],
        ["fetchRemote", "node:child_process.execFile", "spawn", "git"],
        ["remoteBranchHead", "node:child_process.execFile", "spawn", "git"],
        ["pruneWorktrees", "node:child_process.execFile", "spawn", "git"],
        ["removeWorktree", "node:child_process.execFile", "spawn", "git"],
        ["listWorktrees", "node:child_process.execFile", "spawn", "git"],
        ["logRange", "node:child_process.execFile", "spawn", "git"],
        ["diffRange", "node:child_process.execFile", "spawn", "git"],
        ["streamGitTruncatedTo", "node:child_process.spawn", "spawn", "git"],
        ["withIntentToAddTempIndex", "node:fs/promises.mkdtemp", "write"],
        [
          "withIntentToAddTempIndex",
          "node:child_process.execFile",
          "spawn",
          "git",
        ],
        ["withIntentToAddTempIndex", "node:fs/promises.copyFile", "write"],
        ["withIntentToAddTempIndex", "node:fs/promises.rm", "remove"],
        ["diffWorkingTree", "node:child_process.execFile", "spawn", "git"],
        [
          "diffWorkingTreeChangeStats",
          "node:child_process.execFile",
          "spawn",
          "git",
        ],
        ["statusPorcelain", "node:child_process.execFile", "spawn", "git"],
        ["resolveBaseRef", "node:child_process.execFile", "spawn", "git"],
        ["resolveRefSha", "node:child_process.execFile", "spawn", "git"],
        ["readBlob", "node:child_process.execFile", "spawn", "git"],
        ["pathExists", "node:fs/promises.access", "stat"],
        ["hasConflictMarkers", "node:child_process.execFile", "spawn", "git"],
        ["forceWithLeasePush", "node:child_process.execFile", "spawn", "git"],
      ],
    ),
    ...classified(
      "scripts/clean-next-artifacts.mjs",
      "build-tooling",
      "build/CI tooling over the checkout (.next artifacts, generated docs, image smoke); never runs inside the web process",
      [["<module>", "node:fs/promises.rm", "remove"]],
    ),
    ...classified(
      "scripts/export-authored-flow.ts",
      "manager-flow-state",
      "operator CLIs over manager-owned package artifacts (install/import/export/validate); never run inside the web process",
      [
        [
          "main",
          "lib/flows/package-authoring.ts#writeAuthoredFlowPackageDirectory",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "scripts/generate-erd-dbml.ts",
      "build-tooling",
      "build/CI tooling over the checkout (.next artifacts, generated docs, image smoke); never runs inside the web process",
      [
        ["generate", "node:fs.writeFileSync", "write"],
        ["main", "node:fs.readFileSync", "read"],
        ["main", "node:fs.writeFileSync", "write"],
      ],
    ),
    ...classified(
      "scripts/import-flow-package-draft.ts",
      "manager-flow-state",
      "operator CLIs over manager-owned package artifacts (install/import/export/validate); never run inside the web process",
      [
        [
          "main",
          "lib/flows/package-authoring.ts#readAuthoredFlowPackageDirectory",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "scripts/import-legacy-execution-data-plane.ts",
      "operator-import",
      "Stage A history import: reads legacy run directories once, under operator authority, to publish them as host objects",
      [
        ["auditLegacyRuntimeObjects", "node:fs/promises.readdir", "list"],
        ["auditLegacyRuntimeObjects", "node:fs/promises.lstat", "stat"],
        ["readRequiredFile", "node:fs/promises.readFile", "read"],
      ],
      {
        authority:
          "operator CLI: pnpm execution-data-plane:import-legacy, under maintenance with the web drained",
        lifetime:
          "until S4.8 revokes import authority after the guarded cutover",
      },
    ),
    ...classified(
      "scripts/install-package.ts",
      "manager-flow-state",
      "operator CLIs over manager-owned package artifacts (install/import/export/validate); never run inside the web process",
      [["main", "lib/config.ts#loadProjectConfig", "wrapper"]],
    ),
    ...classified(
      "scripts/smoke-production-image.ts",
      "build-tooling",
      "build/CI tooling over the checkout (.next artifacts, generated docs, image smoke); never runs inside the web process",
      [
        ["docker", "node:child_process.execFile", "spawn", "docker"],
        ["<module>", "node:child_process.execFile", "spawn", "docker"],
      ],
    ),
    ...classified(
      "scripts/validate-authored-flow.ts",
      "manager-flow-state",
      "operator CLIs over manager-owned package artifacts (install/import/export/validate); never run inside the web process",
      [
        [
          "main",
          "lib/flows/package-authoring.ts#readAuthoredFlowPackageDirectory",
          "wrapper",
        ],
      ],
    ),
    ...classified(
      "scripts/validate-package-compatibility.ts",
      "manager-flow-state",
      "operator CLIs over manager-owned package artifacts (install/import/export/validate); never run inside the web process",
      [
        [
          "validatePackageCompatibility",
          "lib/packages/manifest.ts#loadMaisterPackageManifest",
          "wrapper",
        ],
        [
          "validatePackageCompatibility",
          "lib/config.ts#loadFlowManifest",
          "wrapper",
        ],
      ],
    ),
  ];

export const filesystemWrapperInventory: readonly FilesystemWrapperEntry[] = [
  ...wrappers(
    "app/api/admin/agents/[agentId]/route.ts",
    "repository-worktree",
    [["GET", false]],
  ),
  ...wrappers("app/api/projects/route.ts", "repository-worktree", [
    ["POST", false],
  ]),
  ...wrappers("lib/agents/dirty-watchdog.ts", "repository-worktree", [
    ["materializeAgentReadOnlySettings", false],
  ]),
  ...wrappers("lib/agents/effective.ts", "repository-worktree", [
    ["resolveEffectiveAgentDefinition", false],
  ]),
  ...wrappers("lib/agents/facade-launch.ts", "repository-worktree", [
    ["resolveFacadeLaunch", false],
  ]),
  ...wrappers("lib/agents/finalization.ts", "repository-worktree", [
    ["finalizeAgentRun", false],
    ["prepareAgentRunFinalization", false],
    ["prepareCheckpointedAgentFailure", false],
  ]),
  ...wrappers("lib/agents/flow-binding.ts", "repository-worktree", [
    ["resolveFlowBoundAgent", false],
  ]),
  ...wrappers("lib/agents/launch.ts", "repository-worktree", [
    ["launchAgentRun", false],
    ["reworkChildRun", false],
    ["sendAgentMessage", false],
    ["startAgentSession", false],
  ]),
  ...wrappers("lib/agents/materialization-lock.ts", "repository-worktree", [
    ["tryAcquireMaterializationLock", false],
  ]),
  ...wrappers("lib/agents/materialization-manifest.ts", "repository-worktree", [
    ["agentMaterializationPathsForRun", false],
    ["assertSafeAgentMaterializationPath", false],
    ["listAgentMaterializationRunIds", false],
    ["materializeWithAgentLease", false],
    ["releaseAgentMaterialization", false],
    ["withAgentMaterializationLock", false],
  ]),
  ...wrappers("lib/agents/memory-store.ts", "manager-flow-state", [
    ["clearAgentMemoryCas", false],
    ["readAgentMemory", false],
    ["readAgentMemoryRaw", false],
    ["writeAgentMemory", false],
    ["writeAgentMemoryCas", false],
  ]),
  ...wrappers("lib/agents/registry.ts", "repository-worktree", [
    ["registerPackageAgents", false],
    ["resyncAgents", false],
  ]),
  ...wrappers("lib/atomic.ts", "manager-flow-state", [
    ["atomicWriteBuffer", true],
    ["atomicWriteJson", true],
    ["atomicWriteText", true],
  ]),
  ...wrappers("lib/auto-promotion/readers.ts", "repository-worktree", [
    ["buildAutoPromotionReaders", false],
  ]),
  ...wrappers("lib/capabilities/adapter-home.ts", "repository-worktree", [
    ["materializeAdapterCapabilityHome", false],
    ["materializeFlowAuthoringSkill", false],
    ["materializeSubagentDefinition", false],
  ]),
  ...wrappers("lib/capabilities/cleanup.ts", "repository-worktree", [
    ["cleanupNodeMaterialization", false],
    ["cleanupRunMaterializations", false],
    ["runCapabilitiesCleanupSweep", false],
  ]),
  ...wrappers("lib/capabilities/import.ts", "repository-worktree", [
    ["confirmCapabilityTrust", false],
    ["installAndIngestCapabilityImports", false],
    ["installCapabilityRevision", false],
    ["runCapabilityRevisionSetup", false],
  ]),
  ...wrappers("lib/capabilities/materialize-bundle.ts", "repository-worktree", [
    ["copyBundleArtifactsToWorktree", false],
    ["ensureWorktreeGitignore", false],
    ["materializeProjectBundlesIntoWorktree", false],
    ["writeAiFactoryConfigOverride", false],
  ]),
  ...wrappers("lib/capabilities/materialize.ts", "repository-worktree", [
    ["ensureWorktreeGitExclude", false],
    ["materializeCapabilityProfile", false],
  ]),
  ...wrappers("lib/capabilities/settings-ownership.ts", "repository-worktree", [
    ["materializeCapabilitySettings", false],
    ["readSettingsOwner", false],
    ["reclaimAgentL2Settings", false],
    ["reclaimCapabilitySettings", false],
  ]),
  ...wrappers("lib/config.ts", "manager-flow-state", [
    ["loadFlowManifest", true],
    ["loadProjectConfig", true],
    ["readAndValidateFormSchemaDoc", true],
    ["readFormSchemaDocWithBytes", true],
    ["resolveOutputResultSchema", true],
    ["resolveOutputResultSchemaWithIdentity", true],
  ]),
  ...wrappers("lib/context-mounts/terminal.ts", "manager-flow-state", [
    ["checkContextMountDirt", false],
    ["releaseRunContextMounts", false],
  ]),
  ...wrappers("lib/db/check-migrations.ts", "migration-tooling", [
    ["findMainMigrationJournalEntry", false],
    ["findPendingBrainMigrations", false],
    ["findPendingMigrations", false],
  ]),
  ...wrappers("lib/db/m43-cutover-migration-root.ts", "migration-tooling", [
    ["createMigrationRootBefore", false],
  ]),
  ...wrappers("lib/evaluations/evidence/store.ts", "manager-evidence", [
    ["readEvidenceBlob", false],
  ]),
  ...wrappers("lib/evaluations/method.ts", "manager-evidence", [
    ["loadEvaluationMethod", false],
  ]),
  ...wrappers("lib/execution-host/adoption.ts", "repository-worktree", [
    ["ensureWorkspaceAdopted", false],
    ["loadWorkspaceSpecInput", false],
  ]),
  ...wrappers(
    "lib/execution-host/capability-profile.ts",
    "repository-worktree",
    [["publishCapabilityBundle", false]],
  ),
  ...wrappers("lib/flows.ts", "manager-flow-state", [
    ["ensureSymlink", true],
    ["gitClone", true],
    ["gitRevParseHead", true],
    ["installAuthoredFlowPackageBridge", false],
    ["installFlowPlugin", false],
    ["installRevision", false],
    ["isLocalDirectorySource", true],
    ["localDirectoryContentDigest", true],
    ["repairPackageRootSchemaCache", false],
    ["runRevisionSetup", false],
  ]),
  ...wrappers("lib/flows/authored-bridge.ts", "manager-flow-state", [
    ["bridgePublishedAuthoredFlow", false],
  ]),
  ...wrappers("lib/flows/graph/artifact-content.ts", "manager-flow-state", [
    ["resolveArtifactContent", false],
  ]),
  ...wrappers("lib/flows/graph/consensus/runtime.ts", "manager-flow-state", [
    ["runConsensusNode", false],
  ]),
  ...wrappers("lib/flows/graph/mutation-check.ts", "manager-flow-state", [
    ["captureNodeStartHead", true],
    ["readNodeStartHead", true],
    ["touchedPaths", false],
  ]),
  ...wrappers("lib/flows/graph/node-output.ts", "manager-flow-state", [
    ["readCliOutputFile", true],
    ["validateNodeStructuredOutput", false],
  ]),
  ...wrappers("lib/flows/graph/run-context.ts", "manager-flow-state", [
    ["ensureRunContextExcluded", false],
    ["isRunContextWriteSafe", false],
  ]),
  ...wrappers("lib/flows/graph/runner-graph.ts", "manager-flow-state", [
    ["runFormCollect", false],
    ["runGraph", false],
    ["runReviewHuman", false],
  ]),
  ...wrappers("lib/flows/graph/workspace-checkpoint.ts", "manager-flow-state", [
    ["applyWorkspacePolicy", false],
    ["captureCheckpoint", false],
    ["deleteChatCheckpoint", false],
    ["deleteRunCheckpointRefs", false],
  ]),
  ...wrappers("lib/flows/lifecycle.ts", "manager-flow-state", [
    ["removeRevision", false],
    ["upgradePreview", false],
  ]),
  ...wrappers("lib/flows/package-authoring.ts", "manager-flow-state", [
    ["readAuthoredFlowPackageDirectory", true],
    ["writeAuthoredFlowPackageDirectory", true],
  ]),
  ...wrappers("lib/flows/package-content.ts", "manager-flow-state", [
    ["listInstalledPackageFiles", true],
    ["readInstalledPackageFile", true],
    ["readInstalledPackageImage", true],
    ["resolveConfinedFlowYaml", true],
  ]),
  ...wrappers("lib/flows/requirements-check.ts", "manager-flow-state", [
    ["checkFlowRequirements", false],
  ]),
  ...wrappers("lib/flows/runner-cli.ts", "manager-flow-state", [
    ["runCliStep", false],
  ]),
  ...wrappers("lib/gc/agent-materialization-gc.ts", "repository-worktree", [
    ["discoverAgentMaterializationCandidateRoots", false],
    ["runAgentMaterializationCleanupSweep", false],
  ]),
  ...wrappers("lib/gc/context-mount-gc.ts", "repository-worktree", [
    ["runContextMountGcSweep", false],
  ]),
  ...wrappers("lib/gc/ephemeral-agent-gc.ts", "repository-worktree", [
    ["runEphemeralAgentGcSweep", false],
  ]),
  ...wrappers("lib/gc/plain-agent-directory-gc.ts", "repository-worktree", [
    ["removeOwnedPlainAgentDirectory", true],
  ]),
  ...wrappers("lib/gc/preserve.ts", "repository-worktree", [
    ["preserveWorktree", false],
  ]),
  ...wrappers("lib/gc/revision-gc.ts", "repository-worktree", [
    ["runRevisionGcSweep", false],
  ]),
  ...wrappers("lib/gc/workspace-reconciler.ts", "repository-worktree", [
    ["runWorkspaceReconciliationSweep", false],
  ]),
  ...wrappers("lib/instance-config.ts", "manager-flow-state", [
    ["hostToolStatus", false],
    ["probeTool", false],
  ]),
  ...wrappers("lib/local-packages/bom.ts", "repository-worktree", [
    ["getLocalPackageBom", false],
    ["localPackageSource", false],
  ]),
  ...wrappers(
    "lib/local-packages/create-flow-operation.ts",
    "repository-worktree",
    [
      ["readCreationJournal", false],
      ["removeCreationJournal", false],
      ["writeCreationJournal", false],
    ],
  ),
  ...wrappers("lib/local-packages/divergence.ts", "repository-worktree", [
    ["computeUpstreamDivergence", false],
    ["loadInstallDir", false],
  ]),
  ...wrappers("lib/local-packages/fork.ts", "repository-worktree", [
    ["forkElementToDefault", false],
    ["forkElementToNewLocal", false],
    ["forkPackageToLocal", false],
  ]),
  ...wrappers("lib/local-packages/git.ts", "repository-worktree", [
    ["ensureLocalPackageGitExclude", false],
    ["gitCommitWorkingDir", false],
    ["gitDiffNoIndex", true],
    ["gitDiscardPaths", false],
    ["gitHeadSha", true],
    ["gitInitWithCommit", true],
    ["gitMergeFile", true],
    ["gitRemoteDefaultBranch", false],
    ["gitSetPublishBranchToHead", false],
    ["gitSetRemote", false],
  ]),
  ...wrappers("lib/local-packages/import.ts", "repository-worktree", [
    ["commitImport", false],
  ]),
  ...wrappers("lib/local-packages/paths.ts", "repository-worktree", [
    ["resolveWithinWorkingDir", true],
  ]),
  ...wrappers("lib/local-packages/service.ts", "repository-worktree", [
    ["addFlowToLocalPackage", false],
    ["assertPackageCommittable", false],
    ["assertPackageCuttable", false],
    ["claimLocalPackageWorkingDir", false],
    ["cleanCopyExcludingGit", false],
    ["commitWorkingDir", false],
    ["createLocalPackage", false],
    ["createLocalPackageWithFlow", false],
    ["deleteLocalPackage", false],
    ["deleteWorkingDirFile", false],
    ["ensureDefaultLocalPackage", false],
    ["exportWorkingDir", false],
    ["listFiles", false],
    ["readFileContent", false],
    ["readWorkingDirArtifactFiles", false],
    ["recoverLocalPackageCreation", false],
    ["registerFlowElementInManifest", false],
    ["removeOwnedLocalPackageWorkingDir", false],
    ["writeWorkingDirFile", false],
  ]),
  ...wrappers("lib/local-packages/sync-merge.ts", "repository-worktree", [
    ["mergeTrees", false],
  ]),
  ...wrappers("lib/local-packages/sync.ts", "repository-worktree", [
    ["resolveSync", false],
  ]),
  ...wrappers("lib/local-packages/versions.ts", "repository-worktree", [
    ["applyPackageVersionChoices", false],
    ["cutLocalPackageVersion", false],
  ]),
  ...wrappers("lib/packages/attach.ts", "repository-worktree", [
    ["installPackageRevision", false],
  ]),
  ...wrappers("lib/packages/catalog.ts", "repository-worktree", [
    ["createPackageSource", false],
    ["refreshPackageSource", false],
    ["refreshStaleSources", false],
  ]),
  ...wrappers("lib/packages/install.ts", "repository-worktree", [
    ["installPackage", false],
    ["resolvePackageSource", false],
  ]),
  ...wrappers("lib/packages/manifest.ts", "repository-worktree", [
    ["loadMaisterPackageManifest", true],
  ]),
  ...wrappers("lib/packages/yaml-writeback.ts", "repository-worktree", [
    ["writeBackPackagesPin", false],
  ]),
  ...wrappers("lib/persist-config.ts", "manager-flow-state", [
    ["persistProjectConfig", false],
  ]),
  ...wrappers("lib/repo-source.ts", "repository-worktree", [
    ["assertGitAvailable", false],
    ["cloneRepo", true],
    ["detectGhAuth", false],
    ["gitInit", true],
    ["isGitRepo", true],
    ["readRemoteOrigin", true],
    ["resolveProjectSource", false],
  ]),
  ...wrappers("lib/runs/hook-trip.ts", "manager-flow-state", [
    ["escalateHookTrip", false],
  ]),
  ...wrappers("lib/runs/keepalive-sweeper.ts", "manager-flow-state", [
    ["runSweepTick", false],
    ["startKeepaliveSweeper", false],
  ]),
  ...wrappers("lib/runs/node-interrupt.ts", "manager-flow-state", [
    ["escalateNodeInterrupt", false],
  ]),
  ...wrappers("lib/runs/pr-adapter.ts", "repository-worktree", [
    ["getPrState", false],
  ]),
  ...wrappers("lib/scheduler/handlers/command.ts", "manager-flow-state", [
    ["runCommandJob", false],
  ]),
  ...wrappers(
    "lib/scratch-runs/local-package-materialization.ts",
    "repository-worktree",
    [["cleanupLocalPackageAssistantMaterialization", false]],
  ),
  ...wrappers(
    "lib/services/gate-chat-turn-completion.ts",
    "repository-worktree",
    [["senseAndRestore", false]],
  ),
  ...wrappers("lib/services/gate-chat.ts", "repository-worktree", [
    ["sendGateChatTurn", false],
  ]),
  ...wrappers("lib/services/runs.ts", "manager-flow-state", [
    ["launchRun", false],
    ["launchRunStaged", false],
  ]),
  ...wrappers("lib/studio/flow-assistant/action-log.ts", "manager-flow-state", [
    ["appendFlowAssistantActionLog", false],
  ]),
  ...wrappers("lib/worktree-provenance.ts", "repository-worktree", [
    ["ensureWorktreeProvenance", false],
    ["hasManagedWorktreeProvenance", false],
    ["installWorktreeProvenance", false],
    ["readWorktreeProvenanceForPromotion", false],
    ["readWorktreeProvenanceMetadata", false],
  ]),
  ...wrappers("lib/worktree.ts", "repository-worktree", [
    ["abortSyncOperation", false],
    ["addDetachedWorktree", false],
    ["addWorktree", false],
    ["addWorktreeForBranch", false],
    ["aheadBehindCounts", false],
    ["assertBaseCommitReachable", false],
    ["branchExists", false],
    ["branchHasUpstream", false],
    ["commitFile", false],
    ["createBranchAtHead", false],
    ["createLocalBranchAt", false],
    ["currentBranchName", false],
    ["deliveryCommitStats", false],
    ["deliveryHistoryStats", false],
    ["diffChangeStats", false],
    ["diffNameStatus", false],
    ["diffRange", false],
    ["diffRunWorkspace", false],
    ["diffRunWorkspaceFileMetadata", false],
    ["diffWorkingTree", false],
    ["diffWorkingTreeChangeStats", false],
    ["discardWorktree", false],
    ["fastForwardWorktreeToRef", false],
    ["fetchRemote", false],
    ["ffUpdateLocalBranch", false],
    ["findTargetMergeByRunId", false],
    ["firstParentDeliveryHistory", false],
    ["forceWithLeasePush", false],
    ["getDefaultBranch", false],
    ["getRemoteUrl", false],
    ["hasConflictMarkers", false],
    ["headCommit", false],
    ["isGitRepo", false],
    ["listBranches", false],
    ["listRemoteUrls", false],
    ["listRemotes", false],
    ["listTree", false],
    ["listWorktrees", false],
    ["localBranchExists", false],
    ["localBranchHead", false],
    ["logRange", false],
    ["logRangeBounded", false],
    ["mergeFromRef", false],
    ["promoteLocalMerge", false],
    ["promoteRebaseMerge", false],
    ["pruneWorktrees", false],
    ["pushBranch", false],
    ["readBlob", false],
    ["rebaseOntoRef", false],
    ["remoteAdd", false],
    ["remoteBranchExists", false],
    ["remoteBranchHead", false],
    ["remoteRemove", false],
    ["remoteSetUrl", false],
    ["remoteTrackingBranchHead", false],
    ["remoteTrackingRefExists", false],
    ["removeBranch", false],
    ["removeOwnedWorktree", false],
    ["removeWorktree", false],
    ["resolveBaseCommit", false],
    ["resolveBaseRef", false],
    ["resolveRefSha", false],
    ["restoreWorktreeToCommit", false],
    ["showFileAtHead", false],
    ["snapshotDirtyWorktree", false],
    ["squashRunBranch", false],
    ["statusPorcelain", false],
    ["syncOperationInProgress", false],
  ]),
];

export const pathGenericWrappers: ReadonlySet<string> = new Set(
  filesystemWrapperInventory
    .filter((entry) => entry.pathGeneric)
    .map((entry) => entry.wrapper),
);
