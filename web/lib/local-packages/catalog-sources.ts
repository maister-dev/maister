import "server-only";

import type {
  CatalogKind,
  SearchQuery,
  SearchResponse,
  SearchResult,
} from "./catalog-contract";
import type { CatalogClient } from "./catalog-client";

import { createHash } from "node:crypto";
import path from "node:path/posix";

import pino from "pino";
import { z } from "zod";

import {
  fetchRegistryPage,
  registryDescriptor,
  reviewMcp,
} from "./catalog-registry";
import { CatalogError, jsonFromCatalog } from "./catalog-client";
import {
  declaredSkillIdentity,
  isSkillsShPinnedUrl,
  resolveSkillsShListing,
  searchSkillsSh,
  skillsShLinkId,
  skillsShSourceId,
} from "./catalog-skills-sh";

import {
  importMaxBytes,
  importMaxFileBytes,
  importMaxEntries,
} from "@/lib/instance-config";

export type { CatalogClient } from "./catalog-client";

const log = pino({
  name: "studio-catalog-sources",
  level: process.env.LOG_LEVEL ?? "info",
});

type Repository = { id: string; repo: string; kind: CatalogKind };
const defaults: Repository[] = [
  { id: "anthropic-skills", repo: "anthropics/skills", kind: "skill" },
  {
    id: "vercel-agent-skills",
    repo: "vercel-labs/agent-skills",
    kind: "skill",
  },
];
const repositoriesSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z0-9-]{1,64}$/),
        repo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
        kind: z.enum(["skill", "mcp"]),
      })
      .strict(),
  )
  .max(12);

function repositories(): Repository[] {
  const raw = process.env.MAISTER_STUDIO_CATALOG_REPOS;

  if (raw === undefined) return defaults;
  let entries: Repository[];

  try {
    entries = repositoriesSchema.parse(JSON.parse(raw));
  } catch {
    throw new CatalogError(
      503,
      "Invalid MAISTER_STUDIO_CATALOG_REPOS configuration",
    );
  }
  if (
    entries.some(
      (e) =>
        e.id === "mcp-registry" ||
        e.repo.split("/").some((p) => p === "." || p === ".."),
    ) ||
    new Set(entries.map((e) => e.id)).size !== entries.length
  )
    throw new CatalogError(503, "Invalid or duplicate approved catalog source");

  return entries;
}

export function isApprovedSource(
  sourceId: string,
  sourceUrl: string,
  kind: CatalogKind,
): boolean {
  if (sourceId === skillsShSourceId)
    return kind === "skill" && isSkillsShPinnedUrl(sourceUrl);
  if (kind === "mcp" && sourceId === "mcp-registry")
    return sourceUrl.startsWith("https://registry.modelcontextprotocol.io/");

  return repositories().some(
    (r) =>
      r.id === sourceId &&
      r.kind === kind &&
      sourceUrl.startsWith("https://github.com/" + r.repo + "/"),
  );
}

export type PinnedCatalogSource = {
  kind: CatalogKind;
  sourceId: string;
  selector: string;
  sourceUrl: string;
  publisher: string;
  pin: string;
  name: string;
  files: Record<string, string>;
  notices: string[];
  configuration: string[];
  mcp?: import("@/lib/config.schema").MaisterPackageManifest["mcps"][number];
};

const hash = z.string().regex(/^[a-f0-9]{40}$/);
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z
    .array(
      z.object({
        path: z.string(),
        sha: hash,
        type: z.string(),
        mode: z.string(),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(32000),
});

type TreeEntry = z.infer<typeof treeSchema>["tree"][number];
type Tree = { pin: string; entries: TreeEntry[] };
const treeCache = new Map<string, { until: number; data: Tree }>();

async function getTree(
  source: Repository,
  read: CatalogClient,
  revision = "HEAD",
  signal?: AbortSignal,
): Promise<Tree> {
  signal?.throwIfAborted();
  const cacheKey = source.repo + "@" + revision;
  const previous = treeCache.get(cacheKey);

  if (read === jsonFromCatalog && previous && previous.until > Date.now())
    return previous.data;
  const base = "https://api.github.com/repos/" + source.repo;
  const commit = z
    .object({
      sha: hash,
      commit: z.object({ tree: z.object({ sha: hash }) }),
    })
    .parse(
      await read(
        new URL(base + "/commits/" + encodeURIComponent(revision)),
        signal,
      ),
    );

  if (hash.safeParse(revision).success && revision !== commit.sha)
    throw new CatalogError(
      422,
      "Catalog commit does not match the requested pin",
    );
  signal?.throwIfAborted();
  const tree = treeSchema.parse(
    await read(
      new URL(base + "/git/trees/" + commit.commit.tree.sha + "?recursive=1"),
      signal,
    ),
  );

  if (tree.truncated)
    throw new CatalogError(422, "Catalog repository tree is truncated");
  signal?.throwIfAborted();
  const data = { pin: commit.sha, entries: tree.tree };

  // Only completed reads may be reused across independently cancelled searches.
  if (read === jsonFromCatalog && treeCache.get(cacheKey) === previous) {
    if (treeCache.size >= 12) treeCache.clear();
    treeCache.set(cacheKey, { until: Date.now() + 30000, data });
  }

  return data;
}

function candidates(source: Repository, entries: TreeEntry[]): SearchResult[] {
  return entries.flatMap((e) => {
    if (e.type !== "blob" || e.mode !== "100644") return [];
    if (source.kind === "skill" && !/^skills\/.+\/SKILL\.md$/.test(e.path))
      return [];
    if (source.kind === "mcp" && !/(^|\/)server\.json$/.test(e.path)) return [];
    const selector = source.kind === "skill" ? path.dirname(e.path) : e.path;
    const name =
      path.basename(path.dirname(e.path)) || source.repo.split("/")[1];

    return [
      {
        sourceId: source.id,
        resultId: selector,
        name,
        publisher:
          source.kind === "skill" ? source.repo : source.repo.split("/")[0],
        kind: source.kind,
      },
    ];
  });
}

function fromLink(q: string, source: Repository): string | null {
  if (!q.toLowerCase().startsWith("https://")) return null;
  let url: URL;

  try {
    url = new URL(q);
  } catch {
    throw new CatalogError(400, "Invalid catalog link");
  }
  if (url.username || url.password || url.port || url.search || url.hash)
    return "";
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.slice(0, 2).join("/").toLowerCase() !== source.repo.toLowerCase())
    return "";
  if (
    ["skills.sh", "www.skills.sh"].includes(url.hostname) &&
    parts.length === 3 &&
    source.kind === "skill"
  )
    return parts[2];
  if (
    url.hostname === "github.com" &&
    ["tree", "blob"].includes(parts[2]) &&
    parts.length >= 5
  )
    return parts
      .slice(4)
      .join("/")
      .replace(/\/SKILL\.md$/, "");

  return "";
}

export async function searchCatalog(
  input: SearchQuery,
  read: CatalogClient = jsonFromCatalog,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  signal?.throwIfAborted();
  const readForSearch: CatalogClient = (url) => read(url, signal);
  const query = input.q.trim();
  const q = query.toLowerCase();
  const sources =
    input.scope === "skills.sh"
      ? []
      : repositories().filter((r) => r.kind === input.kind);
  const exactSkillId = input.kind === "skill" ? skillsShLinkId(query) : null;
  const queryDigest = createHash("sha256")
    .update(JSON.stringify([input.kind, q, sources]))
    .digest("hex")
    .slice(0, 20);
  let cursor: string | undefined;

  if (input.cursor) {
    const decoded = Buffer.from(input.cursor, "base64url").toString("utf8");
    const [digest, ...parts] = decoded.split("|");

    if (digest !== queryDigest || !parts.length || input.kind !== "mcp")
      throw new CatalogError(
        400,
        "Cursor belongs to a different catalog query",
      );
    cursor = parts.join("|");
  }
  const jobs = sources.map((source) => ({
    sourceId: source.id,
    run: async () => {
      if (cursor) return { results: [], cursor: null };
      const selector = fromLink(query, source);

      if (selector === "") return { results: [], cursor: null };
      const link = q.startsWith("https://github.com/") ? new URL(query) : null;
      const revision = link?.pathname.split("/")[4] ?? "HEAD";

      if (
        !/^[a-zA-Z0-9_.-]{1,160}$/.test(revision) ||
        revision === "." ||
        revision === ".."
      )
        throw new CatalogError(422, "Invalid GitHub revision");
      const tree = await getTree(source, read, revision, signal);
      const items = candidates(source, tree.entries);
      const results = items.filter(
        (r) =>
          exactSkillId ||
          (selector
            ? r.resultId === selector
            : (r.name + " " + r.publisher + " " + r.resultId)
                .toLowerCase()
                .includes(q)),
      );

      const identified = await withCanonicalSkillIds(
        source,
        tree,
        results,
        read,
        signal,
      );
      const matches = exactSkillId
        ? identified.filter((item) => item.canonicalSkillId === exactSkillId)
        : identified;

      if (selector && matches.length !== 1)
        return { results: [], cursor: null };

      return {
        results: link
          ? matches.map((r) => ({
              ...r,
              resultId: tree.pin + ":" + r.resultId,
            }))
          : matches,
        cursor: null as string | null,
      };
    },
  }));

  if (input.kind === "mcp" && !q.startsWith("https://"))
    jobs.push({
      sourceId: "mcp-registry",
      run: () => fetchRegistryPage(query, cursor, readForSearch),
    });
  if (
    input.kind === "skill" &&
    input.scope !== "repositories" &&
    q.length >= 2 &&
    (!q.startsWith("https://") || exactSkillId)
  )
    jobs.unshift({
      sourceId: skillsShSourceId,
      run: () => searchSkillsSh(query, readForSearch),
    });
  const pages = await Promise.all(
    jobs.map(async (job) => {
      try {
        return {
          ...(await job.run()),
          sourceId: job.sourceId,
          state: "available" as const,
        };
      } catch (e) {
        signal?.throwIfAborted();
        const status = e instanceof CatalogError ? e.status : 503;
        const reason =
          e instanceof CatalogError &&
          e.details?.reason === "catalog_identity_unavailable"
            ? ("catalog_identity_unavailable" as const)
            : undefined;

        log.warn(
          { sourceId: job.sourceId, status, reason },
          "Catalog search source unavailable",
        );

        return {
          sourceId: job.sourceId,
          state:
            status === 429
              ? ("rate_limited" as const)
              : ("unavailable" as const),
          results: [],
          cursor: null,
          reason,
        };
      }
    }),
  );

  if (
    !input.scope &&
    pages.length &&
    pages.every((p) => p.state !== "available")
  ) {
    const reason = pages.find((page) => page.reason)?.reason;

    throw new CatalogError(
      pages.every((p) => p.state === "rate_limited") ? 429 : 503,
      "Catalog sources are unavailable",
      reason ? { reason } : undefined,
    );
  }
  const next = pages.find((p) => p.cursor)?.cursor;

  return {
    results: pages.flatMap((p) => p.results),
    sources: pages.map((page) => ({
      sourceId: page.sourceId,
      state: page.state,
      ...("reason" in page && page.reason ? { reason: page.reason } : {}),
    })),
    nextCursor: next
      ? Buffer.from(queryDigest + "|" + next).toString("base64url")
      : null,
  };
}

const notice =
  /(?:^|\/)(?:licen[cs]e|copying|(?:third_party_)?notices?)(?:[. _-].*)?$/i;

type VerifiedBlob = { size: number; content: string };

async function readBlob(
  repo: string,
  sha: string,
  read: CatalogClient,
  signal?: AbortSignal,
): Promise<VerifiedBlob> {
  const blob = z
    .object({ encoding: z.literal("base64"), content: z.string() })
    .parse(
      await read(
        new URL("https://api.github.com/repos/" + repo + "/git/blobs/" + sha),
        signal,
      ),
    );
  const bytes = Buffer.from(blob.content, "base64");
  const actual = createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");

  if (actual !== sha)
    throw new CatalogError(422, "Catalog blob integrity mismatch");
  let content: string;

  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new CatalogError(422, "Catalog bundle contains a non-UTF-8 file");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content))
    throw new CatalogError(422, "Catalog bundle contains binary content");

  return { content, size: bytes.length };
}

type SkillIdentity = NonNullable<ReturnType<typeof declaredSkillIdentity>>;
const skillIdentityCache = new Map<string, SkillIdentity | null>();

function skillManifests(tree: Tree): TreeEntry[] {
  return tree.entries.filter(
    (entry) =>
      entry.type === "blob" &&
      ["100644", "100755"].includes(entry.mode) &&
      (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
  );
}

async function readSkillManifest(
  repo: string,
  entry: TreeEntry,
  read: CatalogClient,
  signal?: AbortSignal,
): Promise<SkillIdentity | null> {
  signal?.throwIfAborted();
  const key = repo + "@" + entry.sha + ":" + entry.size;
  const cached =
    read === jsonFromCatalog ? skillIdentityCache.get(key) : undefined;

  if (cached !== undefined) return cached;
  const blob = await readBlob(repo, entry.sha, read, signal);

  if (blob.size !== entry.size)
    throw new CatalogError(422, "Catalog blob integrity mismatch");
  const identity = declaredSkillIdentity(blob.content) ?? null;

  if (read === jsonFromCatalog) {
    if (skillIdentityCache.size >= 256) skillIdentityCache.clear();
    skillIdentityCache.set(key, identity);
  }

  return identity;
}

async function scanSkillManifests(
  source: Repository,
  manifests: TreeEntry[],
  read: CatalogClient,
  signal?: AbortSignal,
): Promise<{ file: string; name: string; slug: string }[]> {
  const maxFile = Math.min(importMaxFileBytes(), 512 * 1024);
  const maxBytes = Math.min(importMaxBytes(), 2 * 1024 * 1024);
  const total = manifests.reduce(
    (size, entry) =>
      size +
      (entry.size !== undefined && entry.size <= maxFile
        ? entry.size
        : Infinity),
    0,
  );

  if (total > maxBytes)
    throw new CatalogError(
      422,
      "Catalog skill declarations exceed review bounds",
    );
  const all: { file: string; name: string; slug: string }[] = [];
  const step = 4;

  for (let i = 0; i < manifests.length; i += step) {
    const batch = await Promise.all(
      manifests.slice(i, i + step).map(async (entry) => {
        const identity = await readSkillManifest(
          source.repo,
          entry,
          read,
          signal,
        );

        return identity ? { file: entry.path, ...identity } : null;
      }),
    );

    all.push(...batch.filter((row) => row !== null));
  }

  return all;
}

async function withCanonicalSkillIds(
  source: Repository,
  tree: Tree,
  results: SearchResult[],
  read: CatalogClient,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (source.kind !== "skill" || results.length === 0) return results;
  const manifests = skillManifests(tree);

  // Search remains usable on larger catalogs without an unverified deduplication hint.
  if (manifests.length > 48) return results;
  const verified = await scanSkillManifests(
    source,
    manifests,
    read,
    signal,
  ).catch((error: unknown) => {
    signal?.throwIfAborted();
    log.warn(
      {
        sourceId: source.id,
        status: error instanceof CatalogError ? error.status : undefined,
      },
      "Catalog skill identities could not be verified",
    );

    return [];
  });
  const byFile = new Map(verified.map((item) => [item.file, item.slug]));
  const count = new Map<string, number>();

  for (const { slug } of verified) count.set(slug, (count.get(slug) ?? 0) + 1);

  return results.map((item) => {
    const slug = byFile.get(item.resultId + "/SKILL.md");

    return slug && count.get(slug) === 1
      ? { ...item, canonicalSkillId: source.repo.toLowerCase() + "/" + slug }
      : item;
  });
}

type CatalogSelection = {
  kind: CatalogKind;
  sourceId: string;
  selector: string;
};
type RepositorySelection = {
  source: Repository;
  tree: Tree;
  path: string;
  identity: string;
  name: string;
  publisher: string;
};

async function selectSkillsShRepository(
  selector: string,
  read: CatalogClient,
): Promise<RepositorySelection> {
  const listing = await resolveSkillsShListing(selector, read);
  const [publisher] = listing.source.split("/");
  const source: Repository = {
    id: skillsShSourceId,
    kind: "skill",
    repo: listing.source,
  };
  const tree = await getTree(source, read);
  const slug = listing.id.split("/")[2];
  const manifests = skillManifests(tree);

  if (manifests.length > 120)
    throw new CatalogError(422, "Too many Git skill declarations to verify");
  const matches = (await scanSkillManifests(source, manifests, read)).filter(
    (item) => item.slug === slug,
  );

  if (matches.length > 1)
    throw new CatalogError(
      422,
      "skills.sh item matches multiple GitHub skill directories",
    );
  if (matches.length === 0)
    throw new CatalogError(
      404,
      "skills.sh item has no matching GitHub skill directory",
    );

  return {
    source,
    tree,
    path: matches[0].file === "SKILL.md" ? "" : path.dirname(matches[0].file),
    identity: listing.id,
    name: matches[0].name,
    publisher,
  };
}

async function selectConfiguredRepository(
  input: CatalogSelection,
  read: CatalogClient,
): Promise<RepositorySelection> {
  const source = repositories().find(
    (r) => r.id === input.sourceId && r.kind === input.kind,
  );

  if (!source) throw new CatalogError(422, "Unapproved catalog source");
  const explicitPin = /^([a-f0-9]{40}):(.+)$/.exec(input.selector);
  const selector = explicitPin?.[2] ?? input.selector;
  const tree = await getTree(source, read, explicitPin?.[1]);
  const item = candidates(source, tree.entries).find(
    (r) => r.resultId === selector,
  );

  if (!item) throw new CatalogError(404, "Catalog item unavailable");

  return {
    source,
    tree,
    path: selector,
    identity: selector,
    name: item.name,
    publisher: item.publisher,
  };
}

export async function resolveCatalogSource(
  input: CatalogSelection,
  read: CatalogClient = jsonFromCatalog,
): Promise<PinnedCatalogSource> {
  if (input.sourceId === "mcp-registry" && input.kind === "mcp")
    return registryDescriptor(input.selector, read);
  const {
    source,
    tree,
    path: selector,
    identity,
    name,
    publisher,
  } = input.sourceId === skillsShSourceId && input.kind === "skill"
    ? await selectSkillsShRepository(input.selector, read)
    : await selectConfiguredRepository(input, read);
  const prefix = selector ? selector + "/" : "";
  const selected = tree.entries.filter(
    (e) =>
      e.type !== "tree" &&
      (input.kind === "skill"
        ? selector
          ? e.path.startsWith(prefix)
          : e.path === "SKILL.md"
        : e.path === selector),
  );
  const rootNotices = tree.entries.filter(
    (e) => !e.path.includes("/") && notice.test(e.path),
  );

  if (
    !selected.length ||
    [...selected, ...rootNotices].length > Math.min(importMaxEntries(), 200)
  )
    throw new CatalogError(
      422,
      "Catalog bundle file count outside supported bounds",
    );
  let size = 0;
  const files: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  const members = [...selected, ...rootNotices].map((entry) => {
    const file = entry.path.startsWith(prefix)
      ? entry.path.slice(prefix.length)
      : rootNotices.includes(entry)
        ? "upstream-notices/" + entry.path
        : "server.json";
    const normalized = file.normalize("NFC").toLowerCase();

    if (
      file.length > 300 ||
      file.includes("\\") ||
      file
        .split("/")
        .some(
          (p) =>
            !p ||
            p.startsWith(".") ||
            p.startsWith("-") ||
            /[\x00-\x1f:]/.test(p),
        ) ||
      seen.has(normalized)
    )
      throw new CatalogError(422, "Unsafe or colliding catalog path");
    seen.add(normalized);
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      entry.size === undefined ||
      entry.size > Math.min(importMaxFileBytes(), 512 * 1024)
    )
      throw new CatalogError(422, "Unsupported catalog file type or size");
    size += entry.size;

    return { entry, file };
  });

  if (size > Math.min(importMaxBytes(), 2 * 1024 * 1024))
    throw new CatalogError(422, "Catalog bundle exceeds total size limit");
  const blobs = new Map<string, VerifiedBlob>();

  // Git can reference the same immutable blob from several distinct member paths.
  for (const { entry, file } of members) {
    const blob =
      blobs.get(entry.sha) ?? (await readBlob(source.repo, entry.sha, read));

    if (blob.size !== entry.size)
      throw new CatalogError(422, "Catalog blob integrity mismatch");
    blobs.set(entry.sha, blob);
    files[file] = blob.content;
  }
  const pinned: PinnedCatalogSource = {
    kind: input.kind,
    sourceId: source.id,
    selector: identity,
    sourceUrl:
      "https://github.com/" +
      source.repo +
      "/tree/" +
      tree.pin +
      (selector
        ? "/" + selector.split("/").map(encodeURIComponent).join("/")
        : ""),
    publisher,
    pin: tree.pin,
    name,
    files,
    notices: Object.keys(files).filter((p) => notice.test(p)),
    configuration: [],
  };

  if (input.kind === "mcp") {
    try {
      return await reviewMcp(JSON.parse(files["server.json"]), pinned, read);
    } catch (e) {
      if (e instanceof CatalogError) throw e;
      throw new CatalogError(422, "Invalid registry server.json descriptor");
    }
  }

  return pinned;
}
