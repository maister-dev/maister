import "server-only";

import type {
  CatalogKind,
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
const treeCache = new Map<string, { until: number; data: Promise<Tree> }>();

async function getTree(
  source: Repository,
  read: CatalogClient,
  revision = "HEAD",
): Promise<Tree> {
  const cacheKey = source.repo + "@" + revision;
  const previous = treeCache.get(cacheKey);

  if (read === jsonFromCatalog && previous && previous.until > Date.now())
    return previous.data;
  const pending = (async () => {
    const base = "https://api.github.com/repos/" + source.repo;
    const commit = z
      .object({
        sha: hash,
        commit: z.object({ tree: z.object({ sha: hash }) }),
      })
      .parse(
        await read(new URL(base + "/commits/" + encodeURIComponent(revision))),
      );

    if (hash.safeParse(revision).success && revision !== commit.sha)
      throw new CatalogError(
        422,
        "Catalog commit does not match the requested pin",
      );
    const tree = treeSchema.parse(
      await read(
        new URL(base + "/git/trees/" + commit.commit.tree.sha + "?recursive=1"),
      ),
    );

    if (tree.truncated)
      throw new CatalogError(422, "Catalog repository tree is truncated");

    return { pin: commit.sha, entries: tree.tree };
  })();

  if (read === jsonFromCatalog) {
    if (treeCache.size >= 12) treeCache.clear();
    treeCache.set(cacheKey, { until: Date.now() + 30000, data: pending });
  }
  try {
    return await pending;
  } catch (error) {
    if (treeCache.get(cacheKey)?.data === pending) treeCache.delete(cacheKey);
    throw error;
  }
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
        publisher: source.repo.split("/")[0],
        kind: source.kind,
      },
    ];
  });
}

function fromLink(q: string, source: Repository): string | null {
  if (!q.startsWith("https://")) return null;
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
  input: { kind: CatalogKind; q: string; cursor?: string },
  read: CatalogClient = jsonFromCatalog,
): Promise<SearchResponse> {
  const q = input.q.trim().toLowerCase();
  const sources = repositories().filter((r) => r.kind === input.kind);
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
      const selector = fromLink(input.q, source);

      if (selector === "") return { results: [], cursor: null };
      const link = input.q.startsWith("https://github.com/")
        ? new URL(input.q)
        : null;
      const revision = link?.pathname.split("/")[4] ?? "HEAD";

      if (
        !/^[a-zA-Z0-9_.-]{1,160}$/.test(revision) ||
        revision === "." ||
        revision === ".."
      )
        throw new CatalogError(422, "Invalid GitHub revision");
      const tree = await getTree(source, read, revision);
      const items = candidates(source, tree.entries);
      const results = items.filter((r) =>
        selector
          ? r.resultId === selector ||
            r.name === selector ||
            selector === source.repo.split("/")[0] + "-" + r.name ||
            selector === "vercel-" + r.name
          : (r.name + " " + r.publisher + " " + r.resultId)
              .toLowerCase()
              .includes(q),
      );

      if (selector && results.length !== 1)
        return { results: [], cursor: null };

      return {
        results: link
          ? results.map((r) => ({
              ...r,
              resultId: tree.pin + ":" + r.resultId,
            }))
          : results,
        cursor: null as string | null,
      };
    },
  }));

  if (input.kind === "mcp" && !input.q.startsWith("https://"))
    jobs.push({
      sourceId: "mcp-registry",
      run: () => fetchRegistryPage(input.q, cursor, read),
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
        log.warn(
          {
            sourceId: job.sourceId,
            status: e instanceof CatalogError ? e.status : 503,
          },
          "Catalog search source unavailable",
        );

        return {
          sourceId: job.sourceId,
          state:
            e instanceof CatalogError && e.status === 429
              ? ("rate_limited" as const)
              : ("unavailable" as const),
          results: [],
          cursor: null,
        };
      }
    }),
  );

  if (pages.length && pages.every((p) => p.state !== "available"))
    throw new CatalogError(
      pages.every((p) => p.state === "rate_limited") ? 429 : 503,
      "Catalog sources are unavailable",
    );
  const next = pages.find((p) => p.cursor)?.cursor;

  return {
    results: pages.flatMap((p) => p.results),
    sources: pages.map(({ sourceId, state }) => ({ sourceId, state })),
    nextCursor: next
      ? Buffer.from(queryDigest + "|" + next).toString("base64url")
      : null,
  };
}

const notice =
  /(?:^|\/)(?:licen[cs]e|copying|(?:third_party_)?notices?)(?:[. _-].*)?$/i;

async function readBlob(
  repo: string,
  entry: TreeEntry,
  read: CatalogClient,
): Promise<string> {
  const blob = z
    .object({ encoding: z.literal("base64"), content: z.string() })
    .parse(
      await read(
        new URL(
          "https://api.github.com/repos/" + repo + "/git/blobs/" + entry.sha,
        ),
      ),
    );
  const bytes = Buffer.from(blob.content, "base64");
  const actual = createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");

  if (bytes.length !== entry.size || actual !== entry.sha)
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

  return content;
}

export async function resolveCatalogSource(
  input: { kind: CatalogKind; sourceId: string; selector: string },
  read: CatalogClient = jsonFromCatalog,
): Promise<PinnedCatalogSource> {
  if (input.sourceId === "mcp-registry" && input.kind === "mcp")
    return registryDescriptor(input.selector, read);
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
  const prefix = selector + "/";
  const selected = tree.entries.filter(
    (e) =>
      e.type !== "tree" &&
      (input.kind === "skill"
        ? e.path.startsWith(prefix)
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
  for (const { entry, file } of members)
    files[file] = await readBlob(source.repo, entry, read);
  const pinned: PinnedCatalogSource = {
    kind: input.kind,
    sourceId: source.id,
    selector,
    sourceUrl:
      "https://github.com/" +
      source.repo +
      "/tree/" +
      tree.pin +
      "/" +
      selector,
    publisher: item.publisher,
    pin: tree.pin,
    name: item.name,
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
