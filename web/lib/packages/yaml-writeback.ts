import "server-only";

import { readFile } from "node:fs/promises";

import pino from "pino";
import { parseDocument, stringify } from "yaml";

import { patchPackageEntries } from "@/lib/project-config-persistence/manifest";
import { atomicWriteText } from "@/lib/atomic";
import { maisterYamlV2Schema } from "@/lib/config.schema";
import { DEFAULT_PUBLIC_BRANCH_TEMPLATE } from "@/lib/workbench-git/public-branch-name";

const log = pino({
  name: "package-yaml-writeback",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PackagesPinEntry = {
  id: string;
  source: string;
  version: string;
  path?: string;
};

export type WriteBackOp =
  { op: "upsert"; entry: PackagesPinEntry } | { op: "remove"; id: string };

export type WriteBackResult = "ok" | "failed" | "skipped";

// ADR-088: after an attach/detach/upgrade transaction COMMITS, the project's
// `maister.yaml packages[]` pin is rewritten so the project can be re-raised
// on another instance from git alone. Comment-preserving (yaml Document API)
// + atomic (tmp + rename). A failure NEVER rolls back the DB operation — the
// caller surfaces `writeBack: "failed"`; the next mutation (or a manual
// edit) heals the file.
export async function writeBackPackagesPin(opts: {
  maisterYamlPath: string | null;
  change: WriteBackOp;
}): Promise<WriteBackResult> {
  // ADR-093: a DB-only project (registered with no maister.yaml) has nothing to
  // write back to — a benign no-op, never a failure. The persist banner nudges
  // the operator to materialize the manifest later.
  if (opts.maisterYamlPath === null) {
    log.info(
      { op: opts.change.op },
      "packages[] write-back skipped — config lives only in the DB",
    );

    return "skipped";
  }

  try {
    const raw = await readFile(opts.maisterYamlPath, "utf8");
    const doc = parseDocument(raw);

    if (doc.errors.length > 0) {
      throw new Error(`yaml parse: ${doc.errors[0]!.message}`);
    }

    const pins = maisterYamlV2Schema.shape.packages.parse(
      (doc.toJS() as Record<string, unknown>).packages ?? [],
    );
    const change = opts.change;
    const retained = pins.filter(
      (pin) =>
        pin.id !== (change.op === "upsert" ? change.entry.id : change.id),
    );
    const desired =
      change.op === "upsert" ? [...retained, change.entry] : retained;

    await atomicWriteText(
      opts.maisterYamlPath,
      patchPackageEntries(raw, desired),
    );
    log.info(
      { path: opts.maisterYamlPath, op: opts.change.op },
      "packages[] pin written back",
    );

    return "ok";
  } catch (err) {
    log.warn(
      {
        path: opts.maisterYamlPath,
        op: opts.change.op,
        cause: (err as Error).message,
      },
      "packages[] write-back failed — DB remains the runtime truth",
    );

    return "failed";
  }
}

export type SerializeProjectInput = {
  name: string;
  mainBranch: string;
  branchPrefix: string;
  // ADR-181: absent = the column default, like an absent YAML key.
  publicBranchTemplate?: string;
  defaultRunnerId: string | null;
  promotionMode: string | null;
};

export type SerializeProjectAttachments = {
  flows?: { id: string; source: string; version: string; runner?: string }[];
  packages?: { id: string; source: string; version: string; path?: string }[];
};

// ADR-093: render a DB-only project's config to a complete, schema-valid
// maister.yaml v2 (the persist serializer — writeBackPackagesPin only edits an
// EXISTING file). Defaults (main/maister/null) are omitted for a clean file;
// the result is round-tripped through maisterYamlV2Schema before returning.
export function serializeProjectConfig(
  project: SerializeProjectInput,
  attachments?: SerializeProjectAttachments,
): string {
  const projectBlock: Record<string, unknown> = { name: project.name };

  if (project.mainBranch !== "main") {
    projectBlock.main_branch = project.mainBranch;
  }
  if (project.branchPrefix !== "maister/") {
    projectBlock.branch_prefix = project.branchPrefix;
  }
  if (
    project.publicBranchTemplate !== undefined &&
    project.publicBranchTemplate !== DEFAULT_PUBLIC_BRANCH_TEMPLATE
  ) {
    projectBlock.public_branch_template = project.publicBranchTemplate;
  }
  if (project.defaultRunnerId) {
    projectBlock.default_runner = project.defaultRunnerId;
  }
  if (project.promotionMode) {
    projectBlock.promotion = { mode: project.promotionMode };
  }

  const doc: Record<string, unknown> = {
    schemaVersion: 2,
    project: projectBlock,
    flows: attachments?.flows ?? [],
  };

  if (attachments?.packages && attachments.packages.length > 0) {
    doc.packages = attachments.packages;
  }

  // Self-check: fail loudly here rather than write an invalid manifest.
  maisterYamlV2Schema.parse(doc);

  return stringify(doc);
}
