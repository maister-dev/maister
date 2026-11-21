"use client";

import type {
  Directory,
  Draft,
  History,
  Issue,
  RevisionDetail,
  View,
} from "./agent-memory-requests";
import type { MemoryPromotionTarget } from "./agent-memory-promotion";

import { Button, Input, Modal } from "@heroui/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { AgentMemoryNavigation } from "./agent-memory-navigation";
import { AgentMemoryPromotion } from "./agent-memory-promotion";
import { AgentMemoryRedact } from "./agent-memory-redact";
import {
  buildVaultCommand,
  displayIssue,
  memoryRoot,
  noteQuery,
  parentPath,
  vaultRequest,
  VaultRequestError,
} from "./agent-memory-requests";

import {
  markdownEditorLabels,
  TaskMarkdownEditor,
} from "@/components/social/task-markdown-editor";
import { MarkdownRichView } from "@/components/workbench/markdown-rich-view";

type Selection = Readonly<{
  key: string;
  page?: View;
  directory?: Directory;
  history?: History;
  revision?: RevisionDetail;
  issue?: Issue;
}>;

function useVaultSelection(
  api: string,
  path: string,
  params: { cursor: string; revision: string; history: string; noteId: string },
  version: number,
) {
  const [state, setState] = useState<Selection>({ key: "" });
  const { cursor, revision, history, noteId } = params;
  const key = JSON.stringify([
    api,
    path,
    cursor,
    revision,
    history,
    noteId,
    version,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };

    async function load() {
      try {
        const selected = revision
          ? await vaultRequest<RevisionDetail>(
              `${api}/revisions/${encodeURIComponent(revision)}${noteId ? `?${new URLSearchParams({ noteId })}` : ""}`,
              options,
            )
          : undefined;
        const stableNoteId = noteId || selected?.revision.noteId;
        const page = await vaultRequest<View>(
          stableNoteId
            ? `${api}/notes?${new URLSearchParams({ noteId: stableNoteId, ...(cursor && { cursor }) })}`
            : noteQuery(api, path, cursor),
          options,
        ).catch((error: unknown) => {
          if (
            selected &&
            error instanceof VaultRequestError &&
            error.issue.status === 404
          )
            return undefined;
          throw error;
        });
        const historyNoteId =
          stableNoteId ?? (page?.kind === "note" ? page.noteId : undefined);
        const [directory, revisions] = await Promise.all([
          page?.kind === "directory"
            ? page
            : page
              ? vaultRequest<Directory>(
                  noteQuery(api, parentPath(page.path)),
                  options,
                )
              : undefined,
          historyNoteId
            ? vaultRequest<History>(
                `${api}/revisions?${new URLSearchParams({ noteId: historyNoteId, ...(history ? { cursor: history } : {}) })}`,
                options,
              )
            : undefined,
        ]);

        if (
          selected &&
          ((stableNoteId && selected.revision.noteId !== stableNoteId) ||
            (page &&
              (page.kind !== "note" ||
                selected.revision.noteId !== page.noteId)))
        )
          throw new VaultRequestError({ code: "PRECONDITION", status: 404 });

        if (!controller.signal.aborted)
          setState({
            key,
            page,
            directory,
            history: revisions,
            revision: selected,
          });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({ key, issue: displayIssue(error) });
      }
    }
    void load();

    return () => controller.abort();
  }, [api, key, path, cursor, revision, history, noteId]);

  return state.key === key ? state : null;
}

type MemoryLocation = Readonly<
  | { kind: "project"; slug: string; projectId: string }
  | { kind: "installation"; companyId: string; bindingId: string }
>;
type EditorDraft = Draft & Readonly<{ submittedBody?: string }>;

export function AgentMemoryControl({
  agentId,
  canEdit,
  canRedact,
  location,
  navigation,
  promotionTargets = [],
}: {
  agentId: string;
  canEdit: boolean;
  canRedact: boolean;
  location: MemoryLocation;
  navigation?: Readonly<{ locationId: string }>;
  promotionTargets?: readonly MemoryPromotionTarget[];
}) {
  const t = useTranslations("agentVault");
  const tReview = useTranslations("inbox.reviews");
  const board = useTranslations("board");
  const format = useFormatter();
  const router = useRouter();
  const search = useSearchParams();
  const agent = encodeURIComponent(agentId);
  const base =
    location.kind === "project"
      ? `/projects/${encodeURIComponent(location.slug)}/agents/${agent}`
      : "/settings/specialists";
  const api =
    location.kind === "project"
      ? `/api${base}/memory`
      : `/api/specialists/${agent}/bindings/${encodeURIComponent(location.bindingId)}/memory`;
  const route: Record<string, string> =
    location.kind === "project" ? {} : { binding: location.bindingId };
  const review: Record<string, string> =
    location.kind === "project"
      ? { projectId: location.projectId }
      : { companyId: location.companyId };
  const requestedPath = search.get("memoryPath") ?? memoryRoot;
  const sourceView = search.get("memoryView") === "source";
  const compare = search.get("memoryView") === "compare";
  const [version, refresh] = useState(0);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [error, setError] = useState<Issue | null>(null);
  const [busy, setBusy] = useState(false);
  const data = useVaultSelection(
    api,
    requestedPath,
    {
      cursor: search.get("memoryCursor") ?? "",
      revision: search.get("memoryRevision") ?? "",
      history: search.get("memoryHistoryCursor") ?? "",
      noteId: search.get("memoryNoteId") ?? "",
    },
    version,
  );
  const { page, directory, history, revision } = data ?? {};
  const path = page?.path ?? revision?.revision.path ?? requestedPath;
  const noteId =
    page?.kind === "note" ? page.noteId : revision?.revision.noteId;
  const newest = search.has("memoryHistoryCursor")
    ? undefined
    : history?.items.at(0);
  const deletedHead =
    !page && newest?.state === "tombstone" && newest.noteId === noteId
      ? {
          kind: "note" as const,
          noteId: newest.noteId,
          revisionId: newest.id,
          path: newest.path,
          hash: null,
        }
      : undefined;
  const href = (target: string, extra: Record<string, string> = {}) =>
    navigation
      ? `/knowledge/memory?${new URLSearchParams({ locationId: navigation.locationId, memoryPath: target, ...extra })}`
      : `${base}?${new URLSearchParams({ ...route, tab: "memory", memoryPath: target, ...extra })}`;
  const textFor = (issue: Issue) =>
    t(
      issue.reason === "agent_memory_attachment_disabled"
        ? "attachmentDisabled"
        : issue.reason === "agent_memory_disabled"
          ? "memoryDisabled"
          : issue.reason === "agent_memory_cutover_required"
            ? "awaitingCutover"
            : issue.code === "CONFLICT"
              ? "conflict"
              : issue.status === 409
                ? "inactive"
                : issue.status === 404
                  ? "missing"
                  : issue.status === 403
                    ? "forbidden"
                    : issue.code === "CONFIG"
                      ? "invalid"
                      : "loadError",
    );

  async function open(action: Draft["action"], revisionId?: string) {
    const selection = page ?? (action === "revert" ? deletedHead : undefined);

    if (!selection) return;
    setError(null);
    setBusy(true);
    try {
      const text =
        action === "edit" && page?.kind === "note"
          ? ((
              await vaultRequest<RevisionDetail>(
                `${api}/revisions/${encodeURIComponent(page.revisionId)}`,
              )
            ).content ?? "")
          : "";
      const destination =
        action === "create"
          ? `${page?.kind === "note" ? parentPath(path) : path}/`
          : path;

      setDraft({
        action,
        text,
        destination,
        revisionId,
        selection,
        requestKey: crypto.randomUUID(),
      });
    } catch (failure) {
      setError(displayIssue(failure));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setDraft(null);
    setError(null);
  }

  function changeDraft(field: "destination" | "text", value: string) {
    if (!draft || busy || draft[field] === value) return;
    setDraft({
      ...draft,
      [field]: value,
      requestKey: crypto.randomUUID(),
      submittedBody: undefined,
    });
    setError(null);
  }

  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        draft.submittedBody ??
        JSON.stringify(await buildVaultCommand(api, draft));

      // A committed tree operation can remove the paths used to build it.
      if (draft.submittedBody === undefined)
        setDraft({ ...draft, submittedBody: body });
      await vaultRequest(`${api}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      setDraft(null);
      refresh((value) => value + 1);
      const target =
        draft.action === "create" || draft.action === "rename"
          ? draft.destination
          : draft.action === "delete"
            ? parentPath(path)
            : path;

      router.replace(href(target));
    } catch (failure) {
      setError(displayIssue(failure));
    } finally {
      setBusy(false);
    }
  }

  function actionButton(action: Draft["action"], id?: string) {
    return (
      <Button
        isDisabled={busy}
        size="sm"
        variant="secondary"
        onPress={() => void open(action, id)}
      >
        {t(action)}
      </Button>
    );
  }

  const conflictHead = error?.current;

  function adoptConflictHead() {
    if (
      !draft ||
      draft.selection.kind !== "note" ||
      !conflictHead?.hash ||
      conflictHead.noteId !== draft.selection.noteId ||
      conflictHead.path !== draft.selection.path
    )
      return;
    const selection = {
      ...draft.selection,
      ...conflictHead,
      hash: conflictHead.hash,
      nextCursor: null,
    };

    setDraft({
      ...draft,
      selection,
      requestKey: crypto.randomUUID(),
      submittedBody: undefined,
    });
    setError(null);
  }

  return (
    <section aria-label={t("title")} className="space-y-4">
      <nav
        aria-label={t("location")}
        className="flex flex-wrap items-center gap-3"
      >
        <Link href={href(memoryRoot)}>{t("root")}</Link>
        {path
          .slice(memoryRoot.length + 1)
          .split("/")
          .filter(Boolean)
          .map((segment, index, segments) => (
            <Link
              key={index}
              className="break-all font-mono text-xs"
              href={href(
                `${memoryRoot}/${segments.slice(0, index + 1).join("/")}`,
              )}
            >
              {segment}
            </Link>
          ))}
      </nav>
      {canEdit ? (
        <Link
          className="text-sm"
          href={`/inbox?${new URLSearchParams({ kind: "vault", ...review, agentId })}#knowledge-memory`}
        >
          {tReview("link")}
        </Link>
      ) : null}
      {data === null ? <p role="status">{t("loading")}</p> : null}
      {data?.issue ? (
        <div role="alert" className="flex gap-2">
          {textFor(data.issue)}{" "}
          {data.issue.status >= 500 ? (
            <Button size="sm" onPress={() => refresh((value) => value + 1)}>
              {t("retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error && !draft ? <p role="alert">{textFor(error)}</p> : null}
      {page ? (
        <AgentMemoryNavigation
          api={api}
          href={href}
          note={page.kind === "note"}
          path={path}
          version={version}
        />
      ) : null}
      {page && canEdit && !revision ? (
        <div className="flex flex-wrap gap-2">
          {actionButton("create")}
          {page.kind === "note" ? actionButton("edit") : null}
          {path !== memoryRoot ? (
            <>
              {actionButton("rename")}
              {actionButton("delete")}
            </>
          ) : null}
          {path === memoryRoot && directory?.entries.length
            ? actionButton("clear")
            : null}
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-[minmax(12rem,1fr)_minmax(0,3fr)]">
        {directory ? (
          <nav
            aria-label={t("tree")}
            className="min-w-0 space-y-2 rounded-xl border border-line p-3"
          >
            <ul className="m-0 list-none space-y-1 p-0">
              {directory.entries.map((entry) => (
                <li key={entry.path}>
                  <Link
                    aria-current={entry.path === path ? "page" : undefined}
                    className="block break-all rounded-md px-2 py-1 text-sm hover:bg-ivory"
                    href={href(entry.path)}
                  >
                    {entry.path.slice(directory.path.length + 1)}
                    {entry.kind === "directory" ? "/" : ""}
                  </Link>
                </li>
              ))}
            </ul>
            {!directory.entries.length ? (
              <p className="m-0 text-sm text-mute">{t("empty")}</p>
            ) : null}
            {directory.nextCursor ? (
              <Link
                href={href(directory.path, {
                  memoryCursor: directory.nextCursor,
                })}
              >
                {t("next")}
              </Link>
            ) : null}
          </nav>
        ) : null}
        {page?.kind === "note" || revision ? (
          <div className="min-w-0 space-y-4">
            <nav className="flex flex-wrap gap-3 text-sm">
              <Link
                href={href(path, {
                  ...(noteId && { memoryNoteId: noteId }),
                  ...(revision && { memoryRevision: revision.revision.id }),
                })}
              >
                {t("preview")}
              </Link>
              <Link
                href={href(path, {
                  memoryView: "source",
                  ...(noteId && { memoryNoteId: noteId }),
                  ...(revision && { memoryRevision: revision.revision.id }),
                })}
              >
                {t("source")}
              </Link>
              {revision?.content !== null &&
              revision &&
              page?.kind === "note" ? (
                <Link
                  href={href(path, {
                    memoryView: "compare",
                    memoryNoteId: page.noteId,
                    memoryRevision: revision.revision.id,
                  })}
                >
                  {t("compare")}
                </Link>
              ) : null}
            </nav>
            {revision ? (
              <p className="break-words text-xs text-mute">
                {t("history")} ·{" "}
                {format.dateTime(new Date(revision.revision.createdAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}{" "}
                · {revision.revision.id}{" "}
                {revision.revision.author
                  ? `· ${revision.revision.author}`
                  : ""}
              </p>
            ) : null}
            {compare && revision && page?.kind === "note" ? (
              <div>
                <p className="text-xs text-mute">{t("comparisonLimit")}</p>
                <div className="grid gap-3 lg:grid-cols-2">
                  <pre
                    aria-label={t("history")}
                    className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-sm"
                  >
                    {revision.content?.slice(0, 32768)}
                  </pre>
                  <pre
                    aria-label={t("current")}
                    className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-sm"
                  >
                    {page.content.slice(0, 32768)}
                  </pre>
                </div>
              </div>
            ) : sourceView || revision?.content === null ? (
              <pre className="overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-paper p-4 text-sm">
                {revision
                  ? (revision.content ?? t(revision.revision.state))
                  : page?.kind === "note"
                    ? page.content
                    : ""}
              </pre>
            ) : (
              <MarkdownRichView
                images="omit"
                path={path}
                source={
                  revision?.content ??
                  (page?.kind === "note" ? page.content : "")
                }
              />
            )}
            {page?.kind === "note" && !revision && promotionTargets.length ? (
              <AgentMemoryPromotion
                key={page.revisionId}
                api={api}
                note={page}
                targets={promotionTargets}
              />
            ) : null}
            {revision ? (
              page?.kind === "note" ? (
                <Link href={href(path, { memoryNoteId: page.noteId })}>
                  {t("current")}
                </Link>
              ) : null
            ) : page?.nextCursor ? (
              <Link
                href={href(path, {
                  memoryCursor: page.nextCursor,
                  ...(sourceView && { memoryView: "source" }),
                  ...(noteId && { memoryNoteId: noteId }),
                })}
              >
                {t("next")}
              </Link>
            ) : null}
            {revision?.revision.state === "available" &&
            (page?.kind === "note" || deletedHead) &&
            canEdit
              ? actionButton("revert", revision.revision.id)
              : null}
            {revision?.revision.state === "available" && canRedact ? (
              <AgentMemoryRedact
                key={revision.revision.id}
                revisionId={revision.revision.id}
                onRedacted={() => {
                  refresh((value) => value + 1);
                  router.replace(href(parentPath(path)));
                }}
              />
            ) : null}
            {history ? (
              <section
                aria-label={t("history")}
                className="space-y-2 rounded-xl border border-line p-3"
              >
                <h2 className="m-0 text-sm font-semibold">{t("history")}</h2>
                <ul className="m-0 list-none space-y-1 p-0">
                  {history.items.map((item) => (
                    <li key={item.id}>
                      <Link
                        aria-current={
                          revision?.revision.id === item.id ? "page" : undefined
                        }
                        href={href(path, {
                          memoryNoteId: item.noteId,
                          memoryRevision: item.id,
                        })}
                      >
                        {format.dateTime(new Date(item.createdAt), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}{" "}
                        · {t(item.state)}
                      </Link>
                    </li>
                  ))}
                </ul>
                {history.nextCursor ? (
                  <Link
                    href={href(path, {
                      memoryHistoryCursor: history.nextCursor,
                      ...(noteId && { memoryNoteId: noteId }),
                    })}
                  >
                    {t("next")}
                  </Link>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
      {draft ? (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open && !busy) close();
          }}
        >
          <Modal.Backdrop
            isDismissable={!busy}
            isKeyboardDismissDisabled={busy}
          >
            <Modal.Container placement="center" scroll="inside">
              <Modal.Dialog className="w-full max-w-xl rounded-xl border border-line bg-paper">
                <Modal.Header>
                  <Modal.Heading>{t(draft.action)}</Modal.Heading>
                  <Modal.CloseTrigger
                    aria-label={t("cancel")}
                    isDisabled={busy}
                  />
                </Modal.Header>
                <Modal.Body className="space-y-3">
                  {draft.action === "create" || draft.action === "rename" ? (
                    <label className="grid gap-1">
                      <span>{t("path")}</span>
                      <Input
                        disabled={busy}
                        value={draft.destination}
                        onChange={(event) =>
                          changeDraft("destination", event.target.value)
                        }
                      />
                    </label>
                  ) : null}
                  {draft.action === "edit" || draft.action === "create" ? (
                    <TaskMarkdownEditor
                      autoFocusOnMount={draft.action === "edit"}
                      disabled={busy}
                      initialMode="source"
                      labels={markdownEditorLabels(board, t("text"))}
                      value={draft.text}
                      onChange={(text) => changeDraft("text", text)}
                    />
                  ) : null}
                  {draft.action === "clear" ||
                  draft.action === "delete" ||
                  draft.action === "revert" ? (
                    <p>{t(`${draft.action}Confirm`)}</p>
                  ) : null}
                  {error ? (
                    <div role="alert">
                      {textFor(error)}
                      {conflictHead ? (
                        <pre className="overflow-auto whitespace-pre-wrap break-words">
                          {conflictHead.content}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                  {conflictHead &&
                  draft.selection.kind === "note" &&
                  conflictHead.noteId === draft.selection.noteId ? (
                    <Button variant="secondary" onPress={adoptConflictHead}>
                      {t("useCurrent")}
                    </Button>
                  ) : null}
                </Modal.Body>
                <Modal.Footer>
                  <Button isDisabled={busy} variant="secondary" onPress={close}>
                    {t("cancel")}
                  </Button>
                  <Button isDisabled={busy} onPress={() => void save()}>
                    {t("save")}
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}
    </section>
  );
}
