import "server-only";

import type { CiCheck } from "@/lib/waits/ci-evidence";

import { z } from "zod";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";

import { MaisterError } from "@/lib/errors";

export type ProviderSource = {
  provider: "github" | "gitlab" | "gitea";
  apiBase: string;
  repository: string;
  headSha: string;
  ref: string;
  token?: string;
};

function providerHeaders(source: ProviderSource): Headers {
  const headers = new Headers({ accept: "application/json" });

  if (source.token)
    headers.set(
      source.provider === "gitlab" ? "private-token" : "authorization",
      source.provider === "gitlab" ? source.token : `Bearer ${source.token}`,
    );

  return headers;
}
type ProviderObservation = { complete: boolean; checks: readonly CiCheck[] };

const PAGE_SIZE = 100;
const PAGE_LIMIT = 8;
const PAGE_BYTES = 1024 * 1024;
const providerId = z.number().int().positive();
const label = z.string().min(1).max(256);
const githubCheckPage = z.object({
  check_runs: z
    .array(
      z.object({
        id: providerId,
        name: label,
        head_sha: z.string(),
        status: label,
        conclusion: z.string().nullable(),
        app: z.object({ slug: label }).nullable().optional(),
      }),
    )
    .max(PAGE_SIZE),
});
const githubStatusPage = z
  .array(
    z.object({
      id: providerId,
      context: label,
      state: label,
      creator: z.object({ login: label }).nullable().optional(),
    }),
  )
  .max(PAGE_SIZE);
const gitlabPipelinePage = z
  .array(
    z.object({
      id: providerId,
      name: label.nullish(),
      status: label,
      source: label,
      ref: label,
      sha: z.string(),
    }),
  )
  .max(PAGE_SIZE);
const giteaStatusPage = z
  .array(
    z.object({
      id: providerId,
      context: label,
      status: label,
      creator: z.object({ login: label }).nullable().optional(),
    }),
  )
  .max(PAGE_SIZE);

function normalizedState(value: string | null): CiCheck["state"] {
  switch (value) {
    case "success":
      return "success";
    case "failure":
    case "failed":
    case "timed_out":
    case "error":
      return "failure";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "pending":
    case "queued":
    case "created":
    case "in_progress":
    case "running":
      return "pending";
    default:
      return "invalid";
  }
}

function providerOrigin(source: ProviderSource): URL {
  const origin = new URL(source.apiBase);
  const segments = source.repository.split("/");

  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    segments.length < 2 ||
    (source.provider !== "gitlab" && segments.length !== 2) ||
    segments.some(
      (value) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value),
    ) ||
    !GIT_OBJECT_ID.test(source.headSha) ||
    !source.ref.startsWith("refs/heads/")
  )
    throw new MaisterError(
      "PRECONDITION",
      "Invalid retained CI publication identity",
    );
  origin.pathname = origin.pathname.replace(/\/$/, "");

  return origin;
}

async function pageJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();

  if (!reader)
    throw new MaisterError(
      "PRECONDITION",
      "CI provider response is missing its page",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > PAGE_BYTES)
        throw new MaisterError(
          "PRECONDITION",
          "CI provider page exceeds its byte limit",
        );
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error: unknown) {
    throw new MaisterError(
      "PRECONDITION",
      "CI provider returned malformed JSON",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function hasNextPage(response: Response, rowCount: number): boolean {
  const nextPage = response.headers.get("x-next-page");
  const link = response.headers.get("link");

  // The next address is always generated from the original approved endpoint.
  if (nextPage !== null) return nextPage.trim() !== "";
  if (link !== null)
    return link
      .split(",")
      .some((part) => /;\s*rel="?next"?(?:\s|$)/.test(part));

  return rowCount === PAGE_SIZE;
}

export async function readProviderCi(
  source: ProviderSource,
  fetchPage: typeof fetch = fetch,
): Promise<ProviderObservation> {
  const root = providerOrigin(source);
  const signal = AbortSignal.timeout(15_000);
  const headers = providerHeaders(source);

  async function collect<T>(
    path: string,
    query: Record<string, string>,
    schema: z.ZodType<T>,
    select: (page: T) => readonly CiCheck[],
    count: (page: T) => number,
  ): Promise<ProviderObservation> {
    const checks: CiCheck[] = [];

    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const url = new URL(root);

      url.pathname += path;
      url.search = new URLSearchParams({
        ...query,
        page: String(page),
        [source.provider === "gitea" ? "limit" : "per_page"]: String(PAGE_SIZE),
      }).toString();
      const response = await fetchPage(url, {
        headers,
        signal,
        redirect: "error",
        cache: "no-store",
      });

      if (!response.ok)
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "CI provider refused the publication check read",
          {
            details: {
              provider: source.provider,
              status: response.status,
              retryAfter: response.headers.get("retry-after"),
            },
          },
        );
      const body = schema.safeParse(await pageJson(response));

      if (!body.success) return { complete: false, checks: [] };
      checks.push(...select(body.data));
      if (!hasNextPage(response, count(body.data)))
        return { complete: true, checks };
    }

    return { complete: false, checks: [] };
  }

  const scope = { headSha: source.headSha, ref: source.ref };
  const refName = source.ref.slice("refs/heads/".length);

  if (source.provider === "gitlab")
    return collect(
      `/projects/${encodeURIComponent(source.repository)}/pipelines`,
      { sha: source.headSha, ref: refName },
      gitlabPipelinePage,
      (page) =>
        page.flatMap((row) =>
          row.name && row.sha === source.headSha && row.ref === refName
            ? [
                {
                  ...scope,
                  name: row.name,
                  issuer: row.source,
                  attempt: BigInt(row.id),
                  state: normalizedState(row.status),
                },
              ]
            : [],
        ),
      (page) => page.length,
    );

  const repository = source.repository
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  if (source.provider === "gitea")
    return collect(
      `/repos/${repository}/statuses/${source.headSha}`,
      {},
      giteaStatusPage,
      (page) =>
        page.flatMap((row) =>
          row.creator
            ? [
                {
                  ...scope,
                  name: row.context,
                  issuer: row.creator.login,
                  attempt: BigInt(row.id),
                  state: normalizedState(row.status),
                },
              ]
            : [],
        ),
      (page) => page.length,
    );

  const prefix = `/repos/${repository}/commits/${source.headSha}`;
  const [runs, statuses] = await Promise.all([
    collect(
      `${prefix}/check-runs`,
      { filter: "all" },
      githubCheckPage,
      (page) =>
        page.check_runs.flatMap((row) =>
          row.app && row.head_sha === source.headSha
            ? [
                {
                  ...scope,
                  name: row.name,
                  issuer: row.app.slug,
                  attempt: BigInt(row.id),
                  state:
                    row.status === "completed"
                      ? normalizedState(row.conclusion)
                      : ("pending" as const),
                },
              ]
            : [],
        ),
      (page) => page.check_runs.length,
    ),
    collect(
      `${prefix}/statuses`,
      {},
      githubStatusPage,
      (page) =>
        page.flatMap((row) =>
          row.creator
            ? [
                {
                  ...scope,
                  name: row.context,
                  issuer: row.creator.login,
                  attempt: BigInt(row.id),
                  state: normalizedState(row.state),
                },
              ]
            : [],
        ),
      (page) => page.length,
    ),
  ]);

  return {
    complete: runs.complete && statuses.complete,
    checks: [...runs.checks, ...statuses.checks],
  };
}

export async function readProviderPublicationHead(
  source: ProviderSource,
  fetchPage: typeof fetch = fetch,
): Promise<string> {
  const url = providerOrigin(source);
  const branch = encodeURIComponent(source.ref.slice("refs/heads/".length));
  const parts = source.repository.split("/").map(encodeURIComponent).join("/");

  url.pathname +=
    source.provider === "gitlab"
      ? `/projects/${encodeURIComponent(source.repository)}/repository/branches/${branch}`
      : `/repos/${parts}/branches/${branch}`;
  const response = await fetchPage(url, {
    headers: providerHeaders(source),
    signal: AbortSignal.timeout(8000),
    redirect: "error",
    cache: "no-store",
  });

  if (!response.ok)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Could not verify the publication branch",
      {
        details: {
          provider: source.provider,
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
        },
      },
    );
  const shape = z.object({
    commit: z.object({ sha: z.string().optional(), id: z.string().optional() }),
  });
  const parsed = shape.safeParse(await pageJson(response));
  const head =
    parsed.success &&
    (source.provider === "github"
      ? parsed.data.commit.sha
      : parsed.data.commit.id);

  if (!head || !GIT_OBJECT_ID.test(head))
    throw new MaisterError(
      "PRECONDITION",
      "Provider did not prove the publication branch head",
    );

  return head;
}
