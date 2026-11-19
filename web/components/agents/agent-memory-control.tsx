"use client";

import type {
  Directory,
  Draft,
  History,
  Issue,
  RevisionDetail,
  View,
} from "./agent-memory-requests";

import { Button, Input, Modal } from "@heroui/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

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
  params: { cursor: string; revision: string; history: string },
  version: number,
) {
  const [state, setState] = useState<Selection>({ key: "" });
  const { cursor, revision, history } = params;
  const key = JSON.stringify([api, path, cursor, revision, history, version]);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };

    async function load() {
      try {
        const page = await vaultRequest<View>(
          noteQuery(api, path, cursor),
          options,
        );
        const [directory, revisions, selected] = await Promise.all([
          page.kind === "directory"
            ? page
            : vaultRequest<Directory>(
                noteQuery(api, parentPath(path)),
                options,
              ),
          page.kind === "note"
            ? vaultRequest<History>(
                `${api}/revisions?${new URLSearchParams({ noteId: page.noteId, ...(history ? { cursor: history } : {}) })}`,
                options,
              )
            : undefined,
          revision
            ? vaultRequest<RevisionDetail>(
                `${api}/revisions/${encodeURIComponent(revision)}`,
                options,
              )
            : undefined,
        ]);

        if (
          selected &&
          (page.kind !== "note" || selected.revision.noteId !== page.noteId)
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
  }, [api, key, path, cursor, revision, history]);

  return state.key === key ? state : null;
}

export function AgentMemoryControl({
  slug,
  agentId,
  canEdit,
}: {
  slug: string;
  agentId: string;
  canEdit: boolean;
}) {
  const t = useTranslations("agentVault");
  const board = useTranslations("board");
  const format = useFormatter();
  const router = useRouter();
  const search = useSearchParams();
  const base = `/projects/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agentId)}`;
  const api = `/api${base}/memory`;
  const path = search.get("memoryPath") ?? memoryRoot;
  const [version, refresh] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<Issue | null>(null);
  const [busy, setBusy] = useState(false);
  const data = useVaultSelection(
    api,
    path,
    {
      cursor: search.get("memoryCursor") ?? "",
      revision: search.get("memoryRevision") ?? "",
      history: search.get("memoryHistoryCursor") ?? "",
    },
    version,
  );
  const { page, directory, history, revision } = data ?? {};
  const href = (target: string, extra: Record<string, string> = {}) =>
    `${base}?${new URLSearchParams({ tab: "memory", memoryPath: target, ...extra })}`;
  const textFor = (issue: Issue) =>
    t(
      issue.code === "CONFLICT"
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
    if (!page) return;
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
        selection: page,
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

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const command = await buildVaultCommand(api, draft);

      await vaultRequest(`${api}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
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
    };

    setDraft({ ...draft, selection, requestKey: crypto.randomUUID() });
    setError(null);
  }

  return (
    <section aria-label={t("title")} className="space-y-4">
      <nav
        aria-label={t("location")}
        className="flex flex-wrap items-center gap-3"
      >
        <Link href={href(memoryRoot)}>{t("root")}</Link>
        {path !== memoryRoot ? (
          <Link href={href(parentPath(path))}>{t("up")}</Link>
        ) : null}
        <span className="break-all font-mono text-xs text-mute">{path}</span>
      </nav>
      {data === null ? <p role="status">{t("loading")}</p> : null}
      {data?.issue ? <p role="alert">{textFor(data.issue)}</p> : null}
      {error && !draft ? <p role="alert">{textFor(error)}</p> : null}
      {page && canEdit ? (
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
        {page?.kind === "note" ? (
          <div className="min-w-0 space-y-4">
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-paper p-4 text-sm">
              {revision
                ? (revision.content ?? t(revision.revision.state))
                : page.content}
            </pre>
            {revision ? (
              <Link href={href(path)}>{t("current")}</Link>
            ) : page.nextCursor ? (
              <Link href={href(path, { memoryCursor: page.nextCursor })}>
                {t("next")}
              </Link>
            ) : null}
            {revision?.revision.state === "available" && canEdit
              ? actionButton("revert", revision.revision.id)
              : null}
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
                        href={href(path, { memoryRevision: item.id })}
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
                        value={draft.destination}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            destination: event.target.value,
                          })
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
                      onChange={(text) => setDraft({ ...draft, text })}
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
