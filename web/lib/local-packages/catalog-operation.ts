import "server-only";

import type {
  CatalogAbortReason,
  CatalogPreview,
  CatalogReceipt,
  ReviewFile,
  applyBody,
} from "./catalog-contract";
import type { PinnedCatalogSource } from "./catalog-sources";

import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import pino from "pino";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { CatalogError } from "./catalog-client";
import {
  catalogManifest,
  registerSkillRoot,
  referencesCatalogItem,
} from "./catalog-manifest";
import { isApprovedSource } from "./catalog-sources";
import { PACKAGE_MANIFEST_FILENAME } from "./manifest";
import {
  isLocalPackageInternalEntryName,
  resolveWithinWorkingDir,
} from "./paths";

import {
  ADAPTER_IDS,
  mcpTransportsForAdapter,
} from "@/lib/acp-runners/adapter-support";
import { atomicWriteJson, atomicWriteText } from "@/lib/atomic";
import { isMaisterError } from "@/lib/errors";

type Owner = { workingDir: string; actorId: string; packageId: string };
type Draft = Pick<Owner, "workingDir" | "packageId">;
type Change = { path: string; before: string | null; after: string | null };
type Request = Omit<z.infer<typeof applyBody>, "sessionId">;
const log = pino({
  name: "studio-catalog-operation",
  level: process.env.LOG_LEVEL ?? "info",
});
const sum = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const safeId = z.string().regex(/^[a-f0-9]{64}$/);
const originSchema = z.object({
  schemaVersion: z.literal(1),
  importId: safeId,
  kind: z.enum(["skill", "mcp"]),
  sourceId: z.string(),
  selector: z.string(),
  pin: z.string(),
  sourceUrl: z.string(),
  publisher: z.string(),
  destination: z.string(),
  notices: z.array(z.string()),
  digest: safeId,
  appliedDigest: safeId,
  files: z.record(z.string(), safeId),
});

type Origin = z.infer<typeof originSchema>;
type SavedPreview = {
  actorId: string;
  source: PinnedCatalogSource;
  result: CatalogPreview;
  origin: Origin;
  manifest: string;
  blobs: Record<string, string>;
};
type Journal = {
  expectedDraftBase: string;
  actorId: string;
  requestDigest: string;
  sourceId: string;
  sourceUrl: string;
  kind: PinnedCatalogSource["kind"];
  changes: Change[];
  receipt: CatalogReceipt;
  abortReason?: CatalogAbortReason;
};
function internal(draft: Draft, part: string): string {
  return path.join(
    path.dirname(draft.workingDir),
    ".maister-catalog",
    sum(draft.packageId),
    part,
  );
}

export async function removeDeletedDraftCatalog(draft: Draft): Promise<void> {
  await rm(internal(draft, ""), { recursive: true, force: true });
}

function originPath(id: string): string {
  return "catalog-origins/" + safeId.parse(id) + ".json";
}
async function optionalText(filename: string): Promise<string | null> {
  try {
    return await readFile(filename, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function readDraft(draft: Draft, name: string): Promise<string | null> {
  const file = await resolveWithinWorkingDir(draft.workingDir, name);

  return readRegularDraftFile(file, name);
}

async function readRegularDraftFile(
  file: string,
  name: string,
): Promise<string | null> {
  try {
    const stat = await lstat(file);

    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new CatalogError(422, "Unsupported draft file: " + name);
    const bytes = await readFile(file);
    const content = bytes.toString("utf8");

    if (!Buffer.from(content, "utf8").equals(bytes))
      throw new CatalogError(422, "Draft file is not UTF-8: " + name);

    return content;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function draftFileDigests(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (isLocalPackageInternalEntryName(entry.name)) continue;
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!entry.isFile())
        throw new CatalogError(
          422,
          "Catalog imports require a draft with regular files",
        );
      const hash = createHash("sha256");

      for await (const bytes of createReadStream(file)) hash.update(bytes);
      entries.set(path.relative(root, file), hash.digest("hex"));
    }
  }
  await walk(root);

  return entries;
}

function treeDigest(
  files: ReadonlyMap<string, string>,
  priorBytes: ReadonlyArray<Change> = [],
): string {
  const entries = new Map(files);

  // Reconstruct the reviewed base from the journal while preserving unrelated current paths.
  for (const change of priorBytes) {
    if (change.before === null) entries.delete(change.path);
    else entries.set(change.path, sum(change.before));
  }

  return sum(
    [...entries]
      .map((entry) => JSON.stringify(entry))
      .sort()
      .join("\n"),
  );
}

async function draftDigest(
  root: string,
  priorBytes: ReadonlyArray<Change> = [],
): Promise<string> {
  return treeDigest(await draftFileDigests(root), priorBytes);
}

async function affectedReferences(
  owner: Owner,
  paths: Iterable<string>,
  source: PinnedCatalogSource,
  destination: string,
  manifest: string,
): Promise<string[]> {
  const name = destination.split("/").at(-1)!;
  const slug = source.kind === "mcp" ? name.replace(/\.yaml$/, "") : name;
  const flows = new Set(
    catalogManifest(manifest).model.flows.map((f) => f.path + "/flow.yaml"),
  );
  const affected: string[] = [];

  for (const file of paths) {
    const agent = /^(?:maister-agents|agents)\/[^/]+\.md$/.test(file);

    if (!agent && !flows.has(file)) continue;
    if (source.kind === "skill" && !agent) {
      affected.push(file);
      continue;
    }
    const text = await readDraft(owner, file);

    if (
      text &&
      referencesCatalogItem(
        text,
        source.kind === "skill" ? "skills" : "mcps",
        slug,
        agent,
      )
    )
      affected.push(file);
  }

  return affected.sort();
}
function sourceKey(
  source: Pick<PinnedCatalogSource, "kind" | "sourceId" | "selector">,
  destination: string,
): string {
  // A revision/version may change on update. A Registry identity includes its namespace.
  const selector =
    source.sourceId === "mcp-registry"
      ? source.selector.slice(0, source.selector.lastIndexOf("@"))
      : source.selector;

  return sum(
    JSON.stringify([source.kind, source.sourceId, selector, destination]),
  );
}
function checkOwnerSource(source: PinnedCatalogSource): void {
  if (!isApprovedSource(source.sourceId, source.sourceUrl, source.kind))
    throw new CatalogError(403, "Catalog source is no longer approved");
}

export async function previewCatalogImport(
  owner: Owner,
  source: PinnedCatalogSource,
  destination: string,
  previousImportId?: string,
): Promise<CatalogPreview> {
  checkOwnerSource(source);
  const manifest = await readDraft(owner, PACKAGE_MANIFEST_FILENAME);

  if (manifest === null)
    throw new CatalogError(422, "Draft manifest is missing");
  const importId = previousImportId ?? sourceKey(source, destination);
  const priorBytes = await readDraft(owner, originPath(importId));

  if (previousImportId && priorBytes === null)
    throw new CatalogError(409, "The update no longer matches this origin");
  if (priorBytes && !previousImportId)
    throw new CatalogError(
      409,
      "Item already imported. Use Update from source",
    );
  const prior = priorBytes ? originSchema.parse(JSON.parse(priorBytes)) : null;

  if (
    prior &&
    (prior.importId !== importId ||
      prior.destination !== destination ||
      sourceKey(prior, destination) !== sourceKey(source, destination))
  )
    throw new CatalogError(
      409,
      "Origin does not match this source and destination",
    );
  let nextManifest: string;
  const blobs: Record<string, string> = Object.create(null);
  let allowedPath: (p: string) => boolean;
  let runnerCompatibility: CatalogPreview["runnerCompatibility"] = null;

  if (source.kind === "skill") {
    const match = /^(.+)\/skills\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,126})$/.exec(
      destination,
    );

    if (!match)
      throw new CatalogError(
        422,
        "Choose a skill destination under a declared capability root",
      );
    const registered = registerSkillRoot(manifest, match[1]);
    const { model } = catalogManifest(manifest);

    for (const root of ["", ...model.capabilities.map((c) => c.path + "/")]) {
      const other = root + "skills/" + match[2];

      if (
        other !== destination &&
        (await readDraft(owner, other + "/SKILL.md")) !== null
      )
        throw new CatalogError(409, "Skill ID already exists at " + other);
    }
    nextManifest = registered.yaml;
    allowedPath = (p) => p.startsWith(destination + "/");
    for (const [rel, bytes] of Object.entries(source.files))
      blobs[destination + "/" + rel] = bytes;
  } else {
    const match = /^mcps\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,126})\.yaml$/.exec(
      destination,
    );

    if (!match) throw new CatalogError(422, "Choose an MCP reference in mcps/");
    const declaration = source.mcp;

    if (!declaration?.transport)
      throw new CatalogError(422, "Reviewed MCP transport is missing");
    const { transport } = declaration;

    runnerCompatibility = {
      transport,
      compatibleAdapters: ADAPTER_IDS.filter((adapter) =>
        mcpTransportsForAdapter(adapter).includes(transport),
      ),
    };
    const { doc } = catalogManifest(manifest);
    const existing =
      (doc.toJS() as { mcps?: Array<Record<string, unknown>> }).mcps ?? [];
    const current = existing.find((m) => m.id === match[1]);

    if (current && !prior)
      throw new CatalogError(409, "MCP reference already exists");
    const mcp = {
      ...declaration,
      id: match[1],
      ...(current?.scope ? { scope: current.scope } : {}),
    };

    // Synchronize the manifest with the descriptor *after* human conflict resolution.
    nextManifest = String(doc);
    const noticePrefix = "catalog-notices/" + importId + "/";

    allowedPath = (p) => p === destination || p.startsWith(noticePrefix);
    blobs[destination] = stringifyYaml(mcp);
    for (const name of source.notices)
      if (Object.hasOwn(source.files, name))
        blobs[noticePrefix + name] = source.files[name];
    if (current && prior) {
      const existingText = await readDraft(owner, destination);

      if (
        existingText === null ||
        !isDeepStrictEqual(parseYaml(existingText), current)
      )
        throw new CatalogError(
          409,
          "MCP descriptor and manifest diverged. Reconcile them before updating",
        );
    }
  }
  const names = Object.keys(blobs).sort();
  const digest = sum(JSON.stringify(names.map((p) => [p, blobs[p]])));
  const origin: Origin = {
    schemaVersion: 1,
    importId,
    kind: source.kind,
    sourceId: source.sourceId,
    selector: source.selector,
    pin: source.pin,
    sourceUrl: source.sourceUrl,
    publisher: source.publisher,
    destination,
    digest,
    appliedDigest: digest,
    notices: source.notices,
    files: Object.fromEntries(names.map((p) => [p, sum(blobs[p])])),
  };
  const files: ReviewFile[] = [];

  for (const p of [
    ...new Set([...names, ...Object.keys(prior?.files ?? {})]),
  ].sort()) {
    if (!allowedPath(p))
      throw new CatalogError(422, "Origin contains a path outside its import");
    const local = await readDraft(owner, p);
    const before = local === null ? null : sum(local);
    const upstream = Object.hasOwn(blobs, p) ? blobs[p] : null;
    const after = upstream === null ? null : sum(upstream);
    const base = prior?.files[p] ?? null;

    if (!prior && before !== null)
      throw new CatalogError(409, "Unrelated draft file already exists: " + p);
    if (before === after) continue;
    if (prior && after === base) {
      files.push({
        path: p,
        change: "local",
        digest: after,
        before: local,
        after: upstream,
      });
      continue;
    }
    const change =
      before !== base
        ? "conflict"
        : upstream === null
          ? "remove"
          : local === null
            ? "add"
            : "modify";

    files.push({
      path: p,
      change,
      digest: after,
      before: local,
      after: upstream,
    });
  }
  const draftIndex = await draftFileDigests(owner.workingDir);
  const result: CatalogPreview = {
    previewId: randomUUID(),
    importId,
    pin: source.pin,
    digest,
    artifactDigest: source.mcp?.distribution?.artifactDigest ?? null,
    expectedDraftBase: treeDigest(draftIndex),
    affectedRefs: await affectedReferences(
      owner,
      draftIndex.keys(),
      source,
      destination,
      manifest,
    ),
    files,
    notices: source.notices,
    configuration: source.configuration,
    runnerCompatibility,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    publisher: source.publisher,
    sourceUrl: source.sourceUrl,
    destination,
  };

  log.debug(
    {
      actorId: owner.actorId,
      packageId: owner.packageId,
      sourceId: source.sourceId,
      pin: source.pin,
      digest,
      fileCount: files.length,
      previewId: result.previewId,
      runnerCompatibility,
    },
    "Catalog source reviewed",
  );
  const dir = internal(owner, "previews");

  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let live = 0;

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    const stat = await lstat(file);

    if (stat.mtimeMs < Date.now() - 15 * 60_000)
      await rm(file, { force: true });
    else live++;
  }
  if (live >= 64)
    throw new CatalogError(429, "Too many active previews for this draft");
  const snapshot: SavedPreview = {
    actorId: owner.actorId,
    source,
    result,
    origin,
    manifest: nextManifest,
    blobs,
  };

  await atomicWriteJson(
    internal(owner, "previews/" + result.previewId + ".json"),
    snapshot,
  );

  return result;
}

function operationFile(owner: Draft, id: string): string {
  return internal(owner, "operations/" + safeId.parse(id) + ".json");
}

type InspectedChange = {
  change: Change;
  file: string;
  current: string | null;
};

async function inspectChange(
  draft: Draft,
  root: string,
  change: Change,
): Promise<InspectedChange | null> {
  try {
    const file = await resolveWithinWorkingDir(draft.workingDir, change.path);

    if (!file.startsWith(root + path.sep)) return null;
    // A replacement symlink or non-directory is an independent edit, even
    // when its target inside the working dir contains the exact reviewed bytes.
    for (
      let parent = path.dirname(file);
      parent !== root;
      parent = path.dirname(parent)
    ) {
      try {
        if (!(await lstat(parent)).isDirectory()) return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    return {
      change,
      file,
      current: await readRegularDraftFile(file, change.path),
    };
  } catch (error) {
    if (
      (error instanceof CatalogError && error.status === 422) ||
      (isMaisterError(error) && error.code === "PRECONDITION") ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    )
      return null;
    throw error;
  }
}

async function matchesReviewedBase(
  draft: Draft,
  journal: Journal,
): Promise<boolean> {
  try {
    return (
      (await draftDigest(draft.workingDir, journal.changes)) ===
      journal.expectedDraftBase
    );
  } catch (error) {
    if (error instanceof CatalogError && error.status === 422) return false;
    throw error;
  }
}

// Called under the same package-wide lease as cut, save, commit and assistant
// apply. The receipt commits the outcome. Before that point an abort compensates
// only exact journaled bytes and leaves independently changed paths untouched.
export async function reconcileCatalogApply(draft: Draft): Promise<void> {
  const pendingFile = internal(draft, "pending.json");
  const raw = await optionalText(pendingFile);

  if (raw === null) return;
  const journal = JSON.parse(raw) as Journal;
  const { operationId } = journal.receipt;
  const receiptFile = operationFile(draft, operationId);
  const completed = await optionalText(receiptFile);

  if (completed !== null) {
    await rm(pendingFile);

    return;
  }
  const root = await realpath(draft.workingDir);
  const unchanged: InspectedChange[] = [];
  const independentPaths: string[] = [];

  for (const change of journal.changes) {
    const inspected = await inspectChange(draft, root, change);

    if (
      inspected &&
      (inspected.current === change.before ||
        inspected.current === change.after)
    )
      unchanged.push(inspected);
    else independentPaths.push(change.path);
  }
  let abortReason = journal.abortReason;

  if (!abortReason) {
    if (!isApprovedSource(journal.sourceId, journal.sourceUrl, journal.kind))
      abortReason = "approval_revoked";
    else if (
      independentPaths.length > 0 ||
      !(await matchesReviewedBase(draft, journal))
    )
      abortReason = "draft_changed";
  }

  // Persist the decision before compensation so that another crash or approval
  // change cannot turn a partially compensated operation into a publish.
  if (abortReason && !journal.abortReason)
    await atomicWriteJson(pendingFile, { ...journal, abortReason });

  for (const { change, file, current } of abortReason
    ? unchanged.reverse()
    : unchanged) {
    const desired = abortReason ? change.before : change.after;

    if (current === desired) continue;
    if (desired === null) await rm(file, { force: true });
    else await atomicWriteText(file, desired);
  }
  const receipt: CatalogReceipt = abortReason
    ? { operationId, state: "aborted", reason: abortReason }
    : {
        operationId,
        state: "applied",
        draftDigest: await draftDigest(draft.workingDir),
      };

  await atomicWriteJson(receiptFile, {
    actorId: journal.actorId,
    requestDigest: journal.requestDigest,
    receipt,
  });
  await rm(pendingFile);
  if (abortReason) {
    log.warn(
      {
        packageId: draft.packageId,
        operationId,
        abortReason,
        independentPaths,
      },
      "Catalog apply compensated",
    );
  } else {
    log.info(
      { packageId: draft.packageId, operationId },
      "Catalog apply reconciled",
    );
  }
}

type StoredOperation = Pick<Journal, "actorId" | "requestDigest" | "receipt">;

async function findOwnedOperation(
  owner: Owner,
  id: string,
): Promise<StoredOperation | null> {
  if (!safeId.safeParse(id).success) return null;
  // Read the journal first: a writer publishes its final receipt before removing it.
  const pending = await optionalText(internal(owner, "pending.json"));
  const applied = await optionalText(operationFile(owner, id));

  for (const bytes of [applied, pending]) {
    if (bytes === null) continue;
    const data = JSON.parse(bytes) as StoredOperation;

    if (data.actorId === owner.actorId && data.receipt.operationId === id)
      return data;
  }

  return null;
}

export async function readCatalogOperation(
  owner: Owner,
  id: string,
): Promise<CatalogReceipt> {
  const saved = await findOwnedOperation(owner, id);

  if (!saved) throw new CatalogError(404, "Operation unavailable");

  return saved.receipt;
}

function requestIdentity(owner: Owner, request: Request) {
  return {
    operationId: sum(JSON.stringify([owner.actorId, request.requestKey])),
    requestDigest: sum(
      JSON.stringify([
        request.previewId,
        request.expectedDraftBase,
        (request.resolutions ?? []).map((r) => [r.path, r.use]).sort(),
      ]),
    ),
  };
}

async function previousReceipt(
  owner: Owner,
  identity: ReturnType<typeof requestIdentity>,
): Promise<CatalogReceipt | null> {
  const saved = await findOwnedOperation(owner, identity.operationId);

  if (!saved) return null;
  if (saved.requestDigest !== identity.requestDigest)
    throw new CatalogError(
      409,
      "Request key already used with a different preview or conflict resolution",
    );

  return saved.receipt;
}

export async function readCatalogRequestReceipt(
  owner: Owner,
  request: Request,
): Promise<CatalogReceipt | null> {
  return previousReceipt(owner, requestIdentity(owner, request));
}

export async function applyCatalogPreview(
  owner: Owner,
  request: Request,
): Promise<CatalogReceipt> {
  const identity = requestIdentity(owner, request);
  const { operationId, requestDigest } = identity;

  await reconcileCatalogApply(owner);
  const previous = await previousReceipt(owner, identity);

  if (previous) return previous;
  if (!z.string().uuid().safeParse(request.previewId).success)
    throw new CatalogError(404, "Preview unavailable");
  const raw = await optionalText(
    internal(owner, "previews/" + request.previewId + ".json"),
  );

  if (raw === null) throw new CatalogError(404, "Preview unavailable");
  const preview = JSON.parse(raw) as SavedPreview;

  if (preview.actorId !== owner.actorId)
    throw new CatalogError(404, "Preview unavailable");
  checkOwnerSource(preview.source);
  if (Date.parse(preview.result.expiresAt) <= Date.now())
    throw new CatalogError(410, "Preview expired");
  if (
    request.expectedDraftBase !== preview.result.expectedDraftBase ||
    (await draftDigest(owner.workingDir)) !== request.expectedDraftBase
  )
    throw new CatalogError(409, "Draft changed since preview");
  const choices = new Map(request.resolutions?.map((r) => [r.path, r.use]));
  const conflicts = preview.result.files.filter((f) => f.change === "conflict");

  if (
    choices.size !== (request.resolutions?.length ?? 0) ||
    choices.size !== conflicts.length ||
    conflicts.some((f) => !choices.has(f.path))
  )
    throw new CatalogError(
      409,
      "Resolve every upstream conflict before applying",
    );
  const changes: Change[] = preview.result.files
    .filter((f) => f.change !== "local" && choices.get(f.path) !== "draft")
    .map((f) => ({ path: f.path, before: f.before, after: f.after }));
  let manifest = preview.manifest;

  if (preview.source.kind === "mcp") {
    const { doc } = catalogManifest(manifest);
    const rel = preview.result.destination;
    const content =
      changes.find((c) => c.path === rel)?.after ??
      (await readDraft(owner, rel));

    if (!content) throw new CatalogError(422, "MCP descriptor missing");
    const parsed = parseYaml(content) as { id: string };
    const old = (doc.toJS() as { mcps?: Array<{ id: string }> }).mcps ?? [];

    doc.set("mcps", [...old.filter((entry) => entry.id !== parsed.id), parsed]);
    manifest = String(doc);
  }
  changes.push({
    path: PACKAGE_MANIFEST_FILENAME,
    before: await readDraft(owner, PACKAGE_MANIFEST_FILENAME),
    after: manifest,
  });
  const tracked: Array<[string, string | null]> = [];

  for (const p of Object.keys(preview.origin.files).sort()) {
    const change = changes.find((c) => c.path === p);

    tracked.push([p, change ? change.after : await readDraft(owner, p)]);
  }
  const origin = {
    ...preview.origin,
    appliedDigest: sum(JSON.stringify(tracked)),
  };
  const originFile = originPath(origin.importId);

  changes.push({
    path: originFile,
    before: await readDraft(owner, originFile),
    after: JSON.stringify(origin, null, 2) + "\n",
  });
  const journal: Journal = {
    expectedDraftBase: request.expectedDraftBase,
    actorId: owner.actorId,
    sourceId: preview.source.sourceId,
    sourceUrl: preview.source.sourceUrl,
    kind: preview.source.kind,
    requestDigest,
    receipt: { operationId, state: "pending" },
    changes,
  };

  await atomicWriteJson(internal(owner, "pending.json"), journal);
  await reconcileCatalogApply(owner);

  return readCatalogOperation(owner, operationId);
}
