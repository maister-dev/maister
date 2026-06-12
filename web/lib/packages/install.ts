import "server-only";

import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path, { join } from "node:path";
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
// package row (ADR-087).
export function packageVersionLabel(version: string): string {
  return version.replaceAll("/", "-");
}

function isLocalPackageSource(source: string): string | null {
  if (source.startsWith("file://")) return source.slice("file://".length);
  if (path.isAbsolute(source)) return source;

  return null;
}

export type ResolvedPackage = {
  pkgRoot: string;
  resolvedRevision: string;
  versionLabel: string;
  manifest: MaisterPackageManifest;
  cleanup: () => Promise<void>;
};

// Resolve a package source ONCE: local dir (file:// or absolute, honoring the
// optional `path` subdir) or a tag-pinned shallow git clone into a tmp dir.
// The caller MUST await `cleanup()` (no-op for local sources) — installPackage
// does this in its `finally`.
export async function resolvePackageSource(opts: {
  source: string;
  version: string;
  path?: string;
  signal?: AbortSignal;
}): Promise<ResolvedPackage> {
  const versionLabel = packageVersionLabel(opts.version);
  const localRoot = isLocalPackageSource(opts.source);

  if (localRoot !== null) {
    const pkgRoot = opts.path ? join(localRoot, opts.path) : localRoot;

    try {
      const st = await stat(pkgRoot);

      if (!st.isDirectory()) throw new Error("not a directory");
    } catch (err) {
      throw new MaisterError(
        "FLOW_INSTALL",
        `package install failed [stage=resolve] ${opts.source}@${opts.version}: ${asError(err).message}`,
        { cause: asError(err) },
      );
    }

    const manifest = await loadMaisterPackageManifest(pkgRoot);
    const resolvedRevision = (await localDirectoryContentDigest(pkgRoot)).slice(
      0,
      LOCAL_REVISION_LEN,
    );

    log.info(
      {
        source: opts.source,
        version: opts.version,
        pkgRoot,
        name: manifest.name,
        revision: resolvedRevision.slice(0, 12),
      },
      "package source resolved (local)",
    );

    return {
      pkgRoot,
      resolvedRevision,
      versionLabel,
      manifest,
      cleanup: async () => {},
    };
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
    const pkgRoot = opts.path ? join(tmpDir, opts.path) : tmpDir;
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

    return { pkgRoot, resolvedRevision, versionLabel, manifest, cleanup };
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

// ADR-087: install every flow + capability bundle a package ships from ONE
// resolved source. Every member sub-install records the package's resolved
// revision (resolvedRevisionOverride) so the group shares one immutable,
// content-addressed identity. setup.sh of capability bundles runs through the
// existing post-install path (local/file:// package roots are
// trusted-by-policy; git package sources follow the prefix policy).
export async function installPackage(
  args: InstallPackageArgs,
): Promise<InstallPackageResult> {
  const resolved = await resolvePackageSource({
    source: args.source,
    version: args.version,
    path: args.path,
    signal: args.signal,
  });

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
      const flowManifest = await loadFlowManifest(join(flowDir, "flow.yaml"));

      if (flowManifest.name !== flow.id) {
        throw new MaisterError(
          "CONFIG",
          `package "${resolved.manifest.name}" flow id "${flow.id}" does not match flow.yaml name "${flowManifest.name}" (${flow.path})`,
        );
      }

      const result = await installFlowPlugin(
        {
          source: pathToFileURL(flowDir).href,
          version: resolved.versionLabel,
          projectId: args.projectId,
          projectSlug: args.projectSlug,
          flowId: flow.id,
          workspaceRoot: args.workspaceRoot,
          roleRefs: args.roleRefs,
          resolvedRevisionOverride: resolved.resolvedRevision,
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
        source: pathToFileURL(join(resolved.pkgRoot, cap.path)).href,
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
