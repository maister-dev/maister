import "server-only";

import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pino from "pino";

import {
  installCapabilityRevision,
  resolveCapabilityTrust,
  runCapabilityRevisionSetup,
} from "@/lib/capabilities/import";
import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import {
  type AgentDefinitionCapabilityConfig,
  type MaisterPackageManifest,
} from "@/lib/config.schema";
import { loadFlowManifest } from "@/lib/config";
import { MaisterError } from "@/lib/errors";
import {
  gitClone,
  gitRevParseHead,
  installFlowPlugin,
  localDirectoryContentDigest,
  type InstallResult,
} from "@/lib/flows";
import { resolveTrust } from "@/lib/flows/trust";
import { loadMaisterPackageManifest } from "@/lib/packages/manifest";
import {
  confinedPackageDirectory,
  materialLayoutDigest,
} from "@/lib/project-dependencies/content-digest";
import { snapshotLocalMaterial } from "@/lib/project-dependencies/material";
import { localDirectoryPath, runtimeFileUrl } from "@/lib/runtime-file-url";

const log = pino({
  name: "package-install",
  level: process.env.LOG_LEVEL ?? "info",
});

const LOCAL_REVISION_LEN = 40;

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// versionTagSchema (flow-paths) forbids "/" — member sub-installs receive the
// path-safe label; the RAW tag is used only for `git clone --branch` and the
// package row (ADR-088).
export function packageVersionLabel(version: string): string {
  return version.replaceAll("/", "-");
}

export type ResolvedPackage = {
  layoutDigest: string;
  pkgRoot: string;
  /** Source coordinate retained by legacy member records, including local aliases. */
  sourceRoot: string;
  resolvedRevision: string;
  versionLabel: string;
  manifest: MaisterPackageManifest;
  cleanup: () => Promise<void>;
};

type LocalPackageDirectory = Pick<ResolvedPackage, "pkgRoot" | "cleanup">;

async function snapshotPackageDirectory(
  source: string,
): Promise<LocalPackageDirectory> {
  const pkgRoot = await snapshotLocalMaterial(source);

  return {
    pkgRoot,
    cleanup: () => rm(pkgRoot, { recursive: true, force: true }),
  };
}

// Resolve a package source ONCE: local dir (file:// or absolute, honoring the
// optional `path` subdir) or a tag-pinned shallow git clone into a tmp dir.
// Managed installs derive manifest, revision and cache bytes from a private copy.
export async function resolvePackageSource(
  opts: {
    source: string;
    version: string;
    path?: string;
    signal?: AbortSignal;
  },
  prepareLocal: (
    source: string,
  ) => Promise<LocalPackageDirectory> = snapshotPackageDirectory,
): Promise<ResolvedPackage> {
  const versionLabel = packageVersionLabel(opts.version);
  const localRoot = localDirectoryPath(opts.source);

  if (localRoot !== null) {
    let pkgRoot = localRoot;

    try {
      if (opts.path)
        pkgRoot = await confinedPackageDirectory(localRoot, opts.path);
      const st = await stat(runtimeFileUrl(pkgRoot));

      if (!st.isDirectory()) throw new Error("not a directory");
    } catch (err) {
      if (err instanceof MaisterError) throw err;
      throw new MaisterError(
        "FLOW_INSTALL",
        `package install failed [stage=resolve] ${opts.source}@${opts.version}: ${asError(err).message}`,
        { cause: asError(err), details: { reason: "source_not_found" } },
      );
    }

    const { pkgRoot: prepared, cleanup } = await prepareLocal(pkgRoot);

    try {
      const layoutDigest = await materialLayoutDigest(prepared);
      const manifest = await loadMaisterPackageManifest(prepared);
      const resolvedRevision = (
        await localDirectoryContentDigest(prepared)
      ).slice(0, LOCAL_REVISION_LEN);

      log.info(
        { source: opts.source, name: manifest.name, resolvedRevision },
        "package source resolved (local)",
      );

      return {
        pkgRoot: prepared,
        sourceRoot: join(localRoot, opts.path ?? "."),
        layoutDigest,
        resolvedRevision,
        versionLabel,
        manifest,
        cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  const tmpDir = await mkdtemp(join(os.tmpdir(), "maister-package-clone-"));
  const cleanup = async (): Promise<void> => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await gitClone({
      source: opts.source,
      version: opts.version,
      target: tmpDir,
      signal: opts.signal,
    });
    const resolvedRevision = await gitRevParseHead({
      dir: tmpDir,
      source: opts.source,
      version: opts.version,
      signal: opts.signal,
    });
    const pkgRoot = opts.path
      ? await confinedPackageDirectory(tmpDir, opts.path)
      : tmpDir;
    const layoutDigest = await materialLayoutDigest(pkgRoot);
    const manifest = await loadMaisterPackageManifest(pkgRoot);

    log.info(
      {
        source: opts.source,
        version: opts.version,
        name: manifest.name,
        revision: resolvedRevision.slice(0, 12),
      },
      "package source resolved (git clone-once)",
    );

    return {
      pkgRoot,
      sourceRoot: pkgRoot,
      resolvedRevision,
      versionLabel,
      manifest,
      cleanup,
      layoutDigest,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export type InstallPackageArgs = {
  source: string;
  version: string;
  path?: string;
  projectId: string;
  projectSlug: string;
  workspaceRoot?: string;
  roleRefs?: readonly string[];
  // FIXME(any): dual drizzle-orm peer-dep variants (see flows.ts).
  db?: any;
  signal?: AbortSignal;
};

export type InstallPackageResult = {
  name: string;
  resolvedRevision: string;
  versionLabel: string;
  manifest: MaisterPackageManifest;
  flows: InstallResult[];
  // Package-derived agent_definition entries for the registration-level
  // SET/CLEAR ingest (installAndIngestCapabilityImports additionalImportDerived).
  capabilityDerived: AgentDefinitionCapabilityConfig[];
};

// ADR-088: install every flow + capability bundle a package ships from ONE
// resolved source. Every member sub-install records the package's resolved
// revision (resolvedRevisionOverride) so the group shares one immutable,
// content-addressed identity. setup.sh of capability bundles runs through the
// existing post-install path (local/file:// package roots are
// trusted-by-policy; git package sources follow the prefix policy).
export async function installPackage(
  args: InstallPackageArgs,
): Promise<InstallPackageResult> {
  const resolved = await resolvePackageSource(
    {
      source: args.source,
      version: args.version,
      path: args.path,
      signal: args.signal,
    },
    // The legacy per-project API records member source paths for later use.
    async (pkgRoot) => ({ pkgRoot, cleanup: async () => {} }),
  );

  try {
    // Trust derives from the ORIGINAL package source (file:// sub-sources are
    // always policy-trusted and would silently loosen the gate for git
    // packages). P2's platform install (T3.3) owns row-level package trust
    // fan-out; here we keep the per-revision posture honest.
    const flowTrust = resolveTrust(args.source);
    const capabilityTrust = resolveCapabilityTrust(args.source);
    const flows: InstallResult[] = [];

    for (const flow of resolved.manifest.flows) {
      const flowDir = join(resolved.pkgRoot, flow.path);
      const flowManifest = await loadFlowManifest(join(flowDir, "flow.yaml"), {
        errorCode: "FLOW_INSTALL",
        surface: "package-member-install",
      });

      if (flowManifest.name !== flow.id) {
        throw new MaisterError(
          "CONFIG",
          `package "${resolved.manifest.name}" flow id "${flow.id}" does not match flow.yaml name "${flowManifest.name}" (${flow.path})`,
        );
      }

      const result = await installFlowPlugin(
        {
          source: pathToFileURL(join(resolved.sourceRoot, flow.path)).href,
          version: resolved.versionLabel,
          projectId: args.projectId,
          projectSlug: args.projectSlug,
          flowId: flow.id,
          workspaceRoot: args.workspaceRoot,
          roleRefs: args.roleRefs,
          resolvedRevisionOverride: resolved.resolvedRevision,
          sharedSchemaDir: join(resolved.pkgRoot, "schemas"),
          resultProfiles: resolved.manifest.result_profiles,
          db: args.db,
          signal: args.signal,
        },
        flowTrust,
      );

      flows.push(result);
      log.info(
        { pkg: resolved.manifest.name, flowId: flow.id, path: flow.path },
        "package flow installed",
      );
    }

    const capabilityDerived: AgentDefinitionCapabilityConfig[] = [];

    for (const cap of resolved.manifest.capabilities) {
      const installed = await installCapabilityRevision({
        source: pathToFileURL(join(resolved.sourceRoot, cap.path)).href,
        version: resolved.versionLabel,
        capabilityRefId: cap.id,
        projectId: args.projectId,
        resolvedRevisionOverride: resolved.resolvedRevision,
        db: args.db,
        signal: args.signal,
      });

      if (capabilityTrust !== "untrusted") {
        await runCapabilityRevisionSetup({
          importRowId: installed.importRowId,
          db: args.db,
          signal: args.signal,
        });
      } else {
        log.warn(
          { pkg: resolved.manifest.name, capabilityRefId: cap.id },
          "package capability setup deferred until trust (untrusted package source)",
        );
      }

      capabilityDerived.push({
        id: cap.id,
        kind: "agent_definition",
        label: cap.id,
        source: "flow-package",
        version: resolved.versionLabel,
        revision: installed.resolvedRevision,
        agents: [...ADAPTER_IDS],
        enforceability: "instructed",
        selected_by_default: true,
      });
      log.info(
        { pkg: resolved.manifest.name, capabilityRefId: cap.id },
        "package capability bundle installed",
      );
    }

    return {
      name: resolved.manifest.name,
      resolvedRevision: resolved.resolvedRevision,
      versionLabel: resolved.versionLabel,
      manifest: resolved.manifest,
      flows,
      capabilityDerived,
    };
  } catch (err) {
    log.warn(
      {
        source: args.source,
        version: args.version,
        err: asError(err).message,
      },
      "package install failed",
    );
    throw err;
  } finally {
    await resolved.cleanup();
  }
}
