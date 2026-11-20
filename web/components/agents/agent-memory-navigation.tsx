"use client";

import type {
  listMemoryBacklinks,
  listMemoryTags,
} from "@/lib/agent-memory-vault/index-queries";
import type { searchMemory } from "@/lib/agent-memory-vault/search";

import { Button, Input } from "@heroui/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import {
  displayIssue,
  vaultRequest,
  type Issue,
} from "./agent-memory-requests";

type Tags = Awaited<ReturnType<typeof listMemoryTags>>;
type Results = Awaited<ReturnType<typeof searchMemory>>;
type Backlinks = Awaited<ReturnType<typeof listMemoryBacklinks>>;
type IndexResult = Readonly<{
  tags?: Tags;
  results?: Results;
  backlinks?: Backlinks;
  issue?: Issue;
}>;
type MemoryHref = (target: string, extra?: Record<string, string>) => string;

export function AgentMemoryNavigation({
  api,
  href,
  path,
  note,
  version,
}: {
  api: string;
  href: MemoryHref;
  path: string;
  note: boolean;
  version: number;
}) {
  const t = useTranslations("agentVault");
  const search = useSearchParams();
  const router = useRouter();
  const q = search.get("memorySearch") ?? "";
  const tag = search.get("memoryTag") ?? "";
  const cursor = search.get("memorySearchCursor") ?? "";
  const tagCursor = search.get("memoryTagCursor") ?? "";
  const backlinkCursor = search.get("memoryBacklinkCursor") ?? "";
  const key = JSON.stringify([
    api,
    path,
    note,
    version,
    q,
    tag,
    cursor,
    tagCursor,
    backlinkCursor,
  ]);
  const [loaded, setLoaded] = useState<{ key: string; data: IndexResult }>();
  const filter = {
    ...(q && { memorySearch: q }),
    ...(tag && { memoryTag: tag }),
  };

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const tagQuery = tagCursor
      ? `?${new URLSearchParams({ cursor: tagCursor })}`
      : "";
    const searchQuery = new URLSearchParams({
      ...(q && { q }),
      ...(tag && { tag }),
      ...(cursor && { cursor }),
    });
    const backlinkQuery = new URLSearchParams({
      path,
      ...(backlinkCursor && { cursor: backlinkCursor }),
    });

    void Promise.all([
      vaultRequest<Tags>(`${api}/tags${tagQuery}`, options),
      q || tag
        ? vaultRequest<Results>(`${api}/search?${searchQuery}`, options)
        : undefined,
      note
        ? vaultRequest<Backlinks>(`${api}/backlinks?${backlinkQuery}`, options)
        : undefined,
    ])
      .then(([tags, results, backlinks]) => {
        if (!controller.signal.aborted)
          setLoaded({ key, data: { tags, results, backlinks } });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({ key, data: { issue: displayIssue(error) } });
      });

    return () => controller.abort();
  }, [api, backlinkCursor, cursor, key, note, path, q, tag, tagCursor]);

  const data = loaded?.key === key ? loaded.data : undefined;

  return (
    <section aria-label={t("browse")} className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = String(
            new FormData(event.currentTarget).get("q") ?? "",
          ).trim();

          router.push(
            href(path, {
              ...(value && { memorySearch: value }),
              ...(tag && { memoryTag: tag }),
            }),
          );
        }}
      >
        <Input
          key={q}
          aria-label={t("searchNotes")}
          defaultValue={q}
          maxLength={2000}
          name="q"
          placeholder={t("searchNotes")}
        />
        <Button size="sm" type="submit" variant="secondary">
          {t("search")}
        </Button>
        {q || tag ? <Link href={href(path)}>{t("resetFilters")}</Link> : null}
      </form>
      {data?.issue ? (
        <p role="alert">
          {t(data.issue.code === "CONFIG" ? "invalid" : "loadError")}
        </p>
      ) : null}
      {data?.tags?.items.length ? (
        <nav aria-label={t("tags")} className="flex flex-wrap gap-3 text-sm">
          {data.tags.items.map((item) => (
            <Link
              key={item.tag}
              aria-current={tag === item.tag ? "true" : undefined}
              href={href(path, {
                ...(q && { memorySearch: q }),
                memoryTag: item.tag,
              })}
            >
              {item.tag} ({item.count})
            </Link>
          ))}
          {data.tags.nextCursor ? (
            <Link
              href={href(path, {
                ...filter,
                memoryTagCursor: data.tags.nextCursor,
              })}
            >
              {t("nextTags")}
            </Link>
          ) : null}
        </nav>
      ) : null}
      {data?.results ? (
        <section
          aria-label={t("searchResults")}
          className="space-y-2 rounded-xl border border-line p-3"
        >
          <h2 className="m-0 text-sm font-semibold">{t("searchResults")}</h2>
          {data.results.hits.length ? (
            <ul className="m-0 list-none space-y-2 p-0">
              {data.results.hits.map((hit) => (
                <li key={hit.noteId}>
                  <Link className="break-all" href={href(hit.path, filter)}>
                    {hit.path}
                  </Link>
                  <p className="m-0 break-words text-sm text-mute">
                    {hit.snippet}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-mute">{t("noMatches")}</p>
          )}
          {data.results.nextCursor ? (
            <Link
              href={href(path, {
                ...filter,
                memorySearchCursor: data.results.nextCursor,
              })}
            >
              {t("nextResults")}
            </Link>
          ) : null}
        </section>
      ) : null}
      {note && data?.backlinks ? (
        <section
          aria-label={t("backlinks")}
          className="space-y-2 rounded-xl border border-line p-3"
        >
          <h2 className="m-0 text-sm font-semibold">{t("backlinks")}</h2>
          {data.backlinks.items.length ? (
            <ul className="m-0 list-none space-y-1 p-0">
              {data.backlinks.items.map((link) => (
                <li key={link.noteId}>
                  <Link className="break-all" href={href(link.path)}>
                    {link.path}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-mute">{t("noBacklinks")}</p>
          )}
          {data.backlinks.nextCursor ? (
            <Link
              href={href(path, {
                ...filter,
                memoryBacklinkCursor: data.backlinks.nextCursor,
              })}
            >
              {t("nextBacklinks")}
            </Link>
          ) : null}
        </section>
      ) : null}
      {data?.backlinks?.structure ? (
        <section
          aria-label={t("noteStructure")}
          className="space-y-2 rounded-xl border border-line p-3 text-sm"
        >
          {data.backlinks.structure.state === "repair" ? (
            <p role="status">{t("needsRepair")}</p>
          ) : null}
          {data.backlinks.structure.aliases.length ? (
            <p>
              {t("aliases", {
                aliases: data.backlinks.structure.aliases.join(", "),
              })}
            </p>
          ) : null}
          {data.backlinks.structure.links.length ? (
            <ul className="m-0 list-none space-y-1 p-0">
              {data.backlinks.structure.links.map((link) => (
                <li key={link.raw} className="break-all">
                  {link.notePath ? (
                    <Link href={href(link.notePath)}>{link.raw}</Link>
                  ) : link.href ? (
                    <Link href={link.href}>{link.raw}</Link>
                  ) : (
                    <span>{t("unresolvedLink", { target: link.raw })}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
