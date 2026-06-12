import "server-only";

import type { DiscoveredPackageEntry } from "@/lib/db/schema";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { loadMaisterPackageManifest } from "@/lib/packages/manifest";
import { redactUrl } from "@/lib/repo-source";

// FIXME(any): dual drizzle-orm peer-dep variants (see flows.ts).
const { packageSources, packageInstalls, projectPackageAttachments } =
  schemaModule as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

const log = pino({
  name: "package-catalog",
  level: process.env.LOG_LEVEL ?? "info",
});

const GIT_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

// --- pure helpers (unit-tested) ---------------------------------------------

// Parses `git ls-remote --tags` stdout into per-package tag lists, keyed by
// the `<name>/vX.Y.Z` convention. Peeled refs (^{}) and non-package tags are
// dropped; tags sort newest-first by the semver suffix.
export function parsePackageTags(stdout: string): Map<string, string[]> {
  const byName = new Map<string, string[]>();

  for (const line of stdout.split(/\r?\n/)) {
    const ref = line.split(/\s+/)[1];

    if (!ref?.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;

    const tag = ref.slice("refs/tags/".length);
    const match =
      /^([A-Za-z0-9._-]+)\/(v\d+(?:\.\d+)*(?:[-+.][A-Za-z0-9.-]+)?)$/.exec(tag);

    if (!match) continue;

    const name = match[1]!;
    const list = byName.get(name) ?? [];

    list.push(tag);
    byName.set(name, list);
  }

  for (const [name, tags] of byName) {
    byName.set(
      name,
      tags.sort((a, b) => compareTagsDesc(a, b)),
    );
  }

  return byName;
}

function semverParts(tag: string): number[] {
  const suffix = tag.slice(tag.lastIndexOf("/v") + 2);

  return suffix.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
}

function compareTagsDesc(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);

  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);

    if (diff !== 0) return diff;
  }

  return 0;
}

// A newer matching tag exists in the source's discovered snapshot. Local
// versions (`local-*` labels) are intentionally off-catalog → never flagged.
export function deriveUpdateAvailable(opts: {
  packageName: string;
  versionLabel: string;
  discovered: DiscoveredPackageEntry[];
}): boolean {
  if (opts.versionLabel.startsWith("local-")) return false;

  const entry = opts.discovered.find((d) => d.name === opts.packageName);
  const newest = entry?.tags[0];

  if (!newest) return false;
  if (!opts.versionLabel.includes("/v")) return false;

  return compareTagsDesc(newest, opts.versionLabel) < 0;
}

// --- sources CRUD ------------------------------------------------------------

export async function listPackageSources(opts?: { db?: any }): Promise<any[]> {
  const db = opts?.db ?? getDb();

  return db.select().from(packageSources);
}

export async function createPackageSource(opts: {
  url: string;
  note?: string;
  enabled?: boolean;
  db?: any;
}): Promise<{ id: string }> {
  const db = opts.db ?? getDb();
  const id = randomUUID();

  const inserted = await db
    .insert(packageSources)
    .values({
      id,
      url: opts.url,
      note: opts.note ?? null,
      enabled: opts.enabled ?? true,
    })
    .onConflictDoNothing()
    .returning({ id: packageSources.id });

  if (inserted.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      `package source already exists for url ${redactUrl(opts.url)}`,
    );
  }

  log.info({ id, url: redactUrl(opts.url) }, "package source created");

  return { id };
}

export async function updatePackageSource(opts: {
  id: string;
  enabled?: boolean;
  note?: string;
  db?: any;
}): Promise<{ updated: boolean }> {
  const db = opts.db ?? getDb();
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (opts.enabled !== undefined) patch.enabled = opts.enabled;
  if (opts.note !== undefined) patch.note = opts.note;

  const rows = await db
    .update(packageSources)
    .set(patch)
    .where(eq(packageSources.id, opts.id))
    .returning({ id: packageSources.id });

  if (rows.length > 0) {
    log.info(
      { id: opts.id, patch: Object.keys(patch) },
      "package source updated",
    );
  }

  return { updated: rows.length > 0 };
}

// Usage-guarded hard delete: refused while any install from this source is
// attached to a project. Installed-but-unattached revisions survive (GC owns
// them).
export async function deletePackageSource(opts: {
  id: string;
  db?: any;
}): Promise<{ deleted: boolean }> {
  const db = opts.db ?? getDb();
  const [source] = await db
    .select()
    .from(packageSources)
    .where(eq(packageSources.id, opts.id));

  if (!source) return { deleted: false };

  const attached = await db
    .select({ id: projectPackageAttachments.id })
    .from(projectPackageAttachments)
    .innerJoin(
      packageInstalls,
      eq(projectPackageAttachments.packageInstallId, packageInstalls.id),
    )
    .where(eq(packageInstalls.sourceUrl, source.url));

  if (attached.length > 0) {
    throw new MaisterError(
      "CONFLICT",
      `package source ${redactUrl(source.url)} has ${attached.length} attached install(s); detach them first`,
    );
  }

  await db.delete(packageSources).where(eq(packageSources.id, opts.id));
  log.info(
    { id: opts.id, url: redactUrl(source.url) },
    "package source deleted",
  );

  return { deleted: true };
}

// --- discovery ----------------------------------------------------------------

export type RefreshResult = {
  degraded: boolean;
  packages: DiscoveredPackageEntry[];
};

async function lsRemoteTags(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["ls-remote", "--tags", url], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER,
    signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  return stdout;
}

async function scanDefaultBranchManifests(
  url: string,
  signal?: AbortSignal,
): Promise<Array<{ name: string; dir: string }>> {
  const tmpDir = await mkdtemp(join(os.tmpdir(), "maister-pkg-discover-"));

  try {
    await execFileAsync("git", ["clone", "--depth", "1", url, tmpDir], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    const packagesDir = join(tmpDir, "packages");
    let entries: string[] = [];

    try {
      entries = (await readdir(packagesDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }

    const names: Array<{ name: string; dir: string }> = [];

    for (const entry of entries) {
      try {
        const manifest = await loadMaisterPackageManifest(
          join(packagesDir, entry),
        );

        names.push({ name: manifest.name, dir: entry });
      } catch {
        log.warn(
          { url: redactUrl(url), dir: entry },
          "packages/ dir without a valid maister-package.yaml — skipped",
        );
      }
    }

    return names;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Refresh one source: ls-remote tags + a shallow default-branch manifest scan.
// ANY git/scan failure degrades to the cached snapshot (WARN) — the catalog
// surface is never blocked by a dead remote.
export async function refreshPackageSource(opts: {
  id: string;
  db?: any;
  signal?: AbortSignal;
}): Promise<RefreshResult | null> {
  const db = opts.db ?? getDb();
  const [source] = await db
    .select()
    .from(packageSources)
    .where(eq(packageSources.id, opts.id));

  if (!source) return null;

  try {
    const [tagStdout, manifestNames] = await Promise.all([
      lsRemoteTags(source.url, opts.signal),
      scanDefaultBranchManifests(source.url, opts.signal),
    ]);
    const byName = parsePackageTags(tagStdout);
    const discovered: DiscoveredPackageEntry[] = manifestNames
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, dir }) => ({ name, dir, tags: byName.get(name) ?? [] }));

    await db
      .update(packageSources)
      .set({ discovered, lastCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(packageSources.id, opts.id));

    log.info(
      {
        id: opts.id,
        url: redactUrl(source.url),
        packages: discovered.length,
        tags: discovered.reduce((n, d) => n + d.tags.length, 0),
      },
      "package source refreshed",
    );

    return { degraded: false, packages: discovered };
  } catch (err) {
    log.warn(
      {
        id: opts.id,
        url: redactUrl(source.url),
        cause: (err as Error).name,
      },
      "package source refresh degraded — keeping stale snapshot",
    );

    return {
      degraded: true,
      packages: (source.discovered ?? []) as DiscoveredPackageEntry[],
    };
  }
}

// --- startup debounce (ADR-087) ---------------------------------------------

const DEFAULT_STALE_HOURS = 24;

// Zod-free on purpose (single integer env): invalid/absent values fall back
// to the default. Wired through .env.example + compose (T3.11).
export function discoveryStaleHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.MAISTER_PACKAGE_DISCOVERY_STALE_HOURS;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_HOURS;
}

// Pure staleness filter (unit-tested): enabled sources never checked or
// checked longer than the window ago.
export function staleSourceFilter(
  sources: ReadonlyArray<{
    id: string;
    enabled: boolean;
    lastCheckedAt: Date | null;
  }>,
  now: Date,
  staleHours: number,
): string[] {
  const cutoff = now.getTime() - staleHours * 60 * 60 * 1000;

  return sources
    .filter(
      (s) =>
        s.enabled &&
        (s.lastCheckedAt === null || s.lastCheckedAt.getTime() < cutoff),
    )
    .map((s) => s.id);
}

// Fire-and-forget startup sweep: refresh enabled sources whose discovery is
// stale. Sequential + per-source try/catch — a dead remote degrades that
// source only and never blocks boot.
export async function refreshStaleSources(opts?: {
  db?: any;
  now?: Date;
}): Promise<{ refreshed: number; degraded: number }> {
  const db = opts?.db ?? getDb();
  const sources = await db.select().from(packageSources);
  const staleIds = staleSourceFilter(
    sources,
    opts?.now ?? new Date(),
    discoveryStaleHours(),
  );

  let refreshed = 0;
  let degraded = 0;

  for (const id of staleIds) {
    try {
      const result = await refreshPackageSource({ id, db });

      if (result?.degraded) degraded += 1;
      else if (result) refreshed += 1;
    } catch (err) {
      degraded += 1;
      log.warn(
        { id, err: (err as Error).message },
        "stale-source refresh threw — continuing",
      );
    }
  }

  log.info(
    { stale: staleIds.length, refreshed, degraded },
    "package discovery sweep",
  );

  return { refreshed, degraded };
}
