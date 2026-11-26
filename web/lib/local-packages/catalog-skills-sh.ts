import "server-only";

import type { CatalogClient } from "./catalog-client";
import type { SearchResult } from "./catalog-contract";

import { z } from "zod";

import { CatalogError } from "./catalog-client";

import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";

export const skillsShSourceId = "skills.sh";
const selectionNamespace = "studio-catalog-skills-sh";
const githubRepo = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/i)
  .refine((repo) => !repo.endsWith("/.") && !repo.endsWith("/.."));
const skillSlug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i);
const listing = z.object({
  id: z.string().max(270),
  source: githubRepo,
  skillId: skillSlug.optional(),
  name: z.string().trim().min(1).max(256),
});

type SkillListing = z.infer<typeof listing>;

// The Skills CLI and its download service derive the route slug from the declared name.
function toSkillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function declaredSkillIdentity(
  content: string,
): { name: string; slug: string } | undefined {
  const document = splitFrontmatter(content);
  const name = document.ok ? document.frontmatter?.name : undefined;

  if (typeof name !== "string" || !name.trim() || name.length > 256) return;
  const slug = toSkillSlug(name);

  if (!skillSlug.safeParse(slug).success) return;

  return { name: name.trim(), slug };
}

function githubListingId(value: string): { repo: string; slug: string } | null {
  const [owner, repository, skill, ...more] = value.split("/");

  if (more.length || !skillSlug.safeParse(skill).success) return null;
  const repo = githubRepo.safeParse(`${owner}/${repository ?? ""}`);

  return repo.success ? { repo: repo.data, slug: skill } : null;
}

const githubListing = listing.refine((entry) => {
  const identity = githubListingId(entry.id);

  return identity?.repo.toLowerCase() === entry.source.toLowerCase();
});

async function listSkills(
  q: string,
  read: CatalogClient,
): Promise<SkillListing[]> {
  const url = new URL("https://skills.sh/api/search");

  url.searchParams.set("q", q);
  url.searchParams.set("limit", "30");
  const parsed = z
    .object({ skills: z.array(z.unknown()).max(30) })
    .safeParse(await read(url));

  if (!parsed.success)
    throw new CatalogError(503, "Unexpected skills.sh search response");
  const entries = new Map<string, SkillListing>();

  for (const value of parsed.data.skills) {
    const entry = githubListing.safeParse(value);

    if (entry.success) {
      const id = entry.data.id.toLowerCase();

      entries.set(id, {
        ...entry.data,
        id,
        source: entry.data.source.toLowerCase(),
      });
    }
  }

  return [...entries.values()];
}

export function skillsShLinkId(input: string): string | null {
  const url = URL.parse(input);

  if (
    !url ||
    url.protocol !== "https:" ||
    !["skills.sh", "www.skills.sh"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return null;
  const id = url.pathname.slice(1).replace(/\/$/, "").toLowerCase();

  return githubListingId(id) ? id : null;
}

export async function searchSkillsSh(
  q: string,
  read: CatalogClient,
): Promise<{ results: SearchResult[]; cursor: null }> {
  const id = skillsShLinkId(q);
  const skills = id
    ? [await readExactListing(id, read)]
    : await listSkills(q, read);

  return {
    results: skills.map((entry) => ({
      kind: "skill",
      sourceId: skillsShSourceId,
      resultId: signCursorPayload(selectionNamespace, {
        ...entry,
        name: skillSlug.safeParse(entry.name).success
          ? entry.name
          : entry.id.split("/")[2],
      }),
      name: entry.name,
      publisher: entry.source,
      canonicalSkillId: entry.id,
    })),
    cursor: null,
  };
}

const downloadSnapshot = z.object({
  files: z.array(z.object({ path: z.string(), contents: z.string() })).max(200),
  hash: z.string().regex(/^[a-f0-9]{64}$/i),
});

function inconclusiveListing(status?: number): CatalogError {
  return new CatalogError(
    status === 429 ? 429 : 503,
    "The exact skills.sh item could not be confirmed",
    { reason: "catalog_identity_unavailable" },
  );
}

async function readExactListing(
  id: string,
  read: CatalogClient,
): Promise<SkillListing> {
  const identity = githubListingId(id);

  if (!identity)
    throw new CatalogError(422, "Invalid skills.sh listing identifier");
  const url = new URL(
    "https://skills.sh/api/download/" +
      id.split("/").map(encodeURIComponent).join("/"),
  );
  let upstream: unknown;

  try {
    upstream = await read(url);
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    throw inconclusiveListing(error.status);
  }
  const snapshot = downloadSnapshot.safeParse(upstream);
  const manifests = snapshot.success
    ? snapshot.data.files.filter(({ path }) => path === "SKILL.md")
    : [];
  const declared =
    manifests.length === 1
      ? declaredSkillIdentity(manifests[0].contents)
      : undefined;

  // A snapshot is evidence of the exact listing only. The reviewed bytes come from Git.
  if (!declared || declared.slug !== identity.slug.toLowerCase())
    throw inconclusiveListing();

  return {
    id: id.toLowerCase(),
    source: identity.repo.toLowerCase(),
    name: declared.name,
  };
}

/** First previews use the search receipt. Retained origins are portable and recheck discovery. */
export async function resolveSkillsShListing(
  selector: string,
  read: CatalogClient,
): Promise<SkillListing> {
  if (githubListingId(selector)) return readExactListing(selector, read);

  try {
    return githubListing.parse(
      parseCursorPayload(selectionNamespace, selector),
    );
  } catch {
    throw new CatalogError(422, "Select a GitHub skill from skills.sh search");
  }
}

export function isSkillsShPinnedUrl(sourceUrl: string): boolean {
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/[a-f0-9]{40}(?:\/[^?#\\\s]*)?$/.exec(
      sourceUrl,
    );

  return Boolean(
    match &&
    githubRepo.safeParse(match[1]).success &&
    URL.parse(sourceUrl)?.href === sourceUrl,
  );
}
