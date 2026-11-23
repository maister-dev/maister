"use client";

import type { ProjectDependencyView } from "@/lib/project-dependencies/view";
import type { FormEvent, ReactElement } from "react";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";

const buttonClass =
  "rounded-lg border border-line px-3 py-1 font-semibold disabled:opacity-50";
const fieldClass = "block w-full rounded-lg border border-line p-2 font-mono";

type DialogKind = "edit" | "recover-setup";

function DeclarationRow({
  slug,
  row,
}: {
  slug: string;
  row: ProjectDependencyView;
}): ReactElement {
  const t = useTranslations("dependencies");
  const router = useRouter();
  const [dialog, setDialog] = useState<{
    kind: DialogKind;
    snapshot: ProjectDependencyView;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/api/projects/${encodeURIComponent(slug)}/dependency-declarations/${encodeURIComponent(row.id)}`;

  async function send(
    action: "retry" | DialogKind,
    body: Record<string, unknown>,
  ): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        action === "edit" ? base : `${base}/${action}`,
        {
          method: action === "edit" ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      if (response.ok) setDialog(null);
      else if (response.status === 409) {
        setDialog(null);
        const failure = await response.json();

        setNotice(
          t(
            failure.details?.reason === "operation_busy"
              ? "publicationBusy"
              : failure.details?.reason === "setup_owner_live"
                ? "setupLive"
                : "conflict",
          ),
        );
      } else setNotice(t("refused"));
      router.refresh();
    } catch {
      setNotice(t("requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  function edit(
    event: FormEvent<HTMLFormElement>,
    expectedGeneration: number,
  ): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const path = String(data.get("path") ?? "").trim();

    void send("edit", {
      expectedGeneration,
      source: String(data.get("source") ?? "").trim(),
      version: String(data.get("version") ?? "").trim(),
      ...(path ? { path } : {}),
    });
  }
  const reasonKey = row.reason ? `reasons.${row.reason}` : null;
  const stageKey = row.stage ? `stages.${row.stage}` : null;

  return (
    <li
      className="space-y-2 rounded-lg border border-line p-3"
      id={`dependency-${row.id}`}
    >
      <h4 className="font-semibold">
        {row.ref}{" "}
        <span className="font-normal text-mute">
          · {t(`kinds.${row.kind}`)}
        </span>
      </h4>
      <p>
        {t("requested")}{" "}
        <code className="break-all">
          {row.source} @ {row.version}
          {row.path ? ` · ${row.path}` : ""}
        </code>
      </p>
      <p>
        {t("effective")} <code>{row.effectiveRevision ?? "—"}</code> ·{" "}
        {t(`readiness.${row.readiness}`)}
      </p>
      {row.state ? (
        <p>
          {t(`states.${row.state}`)}
          {stageKey ? ` · ${t.has(stageKey) ? t(stageKey) : row.stage}` : ""}
          {reasonKey
            ? ` · ${t.has(reasonKey) ? t(reasonKey) : t("reasons.installation_failed")}`
            : ""}
        </p>
      ) : null}
      {row.memberRef && row.state !== "succeeded" ? (
        <p>
          {t("member")}{" "}
          <code>
            {row.memberRef}
            {row.resolvedRevision ? ` @ ${row.resolvedRevision}` : ""}
          </code>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {row.actions.edit && (
          <button
            className={buttonClass}
            disabled={busy}
            type="button"
            onClick={() => setDialog({ kind: "edit", snapshot: row })}
          >
            {t("edit")}
          </button>
        )}
        {row.actions.retry && (
          <button
            className={buttonClass}
            data-action="retry"
            disabled={busy}
            type="button"
            onClick={() =>
              void send("retry", {
                expectedGeneration: row.generation,
                expectedAttempt: row.attempt,
              })
            }
          >
            {t("retry")}
          </button>
        )}
        {row.actions.recoverSetup && (
          <button
            className={buttonClass}
            disabled={busy}
            type="button"
            onClick={() => setDialog({ kind: "recover-setup", snapshot: row })}
          >
            {t("recover")}
          </button>
        )}
      </div>
      {notice && !dialog ? <p role="alert">{notice}</p> : null}
      {dialog ? (
        <ConfirmDialog
          body={
            dialog.kind === "edit"
              ? dialog.snapshot.ref
              : t("recoverBody", {
                  member: dialog.snapshot.memberRef ?? "",
                  revision: dialog.snapshot.resolvedRevision ?? "",
                })
          }
          busy={busy}
          cancelLabel={t("cancel")}
          testId="dependency-command-dialog"
          title={t(dialog.kind === "edit" ? "edit" : "recover")}
          titleId={`dependency-dialog-${row.id}`}
          onClose={() => setDialog(null)}
        >
          {notice ? <p role="alert">{notice}</p> : null}
          {dialog.kind === "edit" ? (
            <form
              className="space-y-2"
              onSubmit={(event) => edit(event, dialog.snapshot.generation)}
            >
              {(["source", "version", "path"] as const).map((field) => (
                <label key={field} className="block">
                  {t(field)}
                  <input
                    className={fieldClass}
                    defaultValue={dialog.snapshot[field] ?? ""}
                    name={field}
                    required={field !== "path"}
                  />
                </label>
              ))}
              <button className={buttonClass} disabled={busy} type="submit">
                {t("save")}
              </button>
            </form>
          ) : (
            <button
              className={buttonClass}
              disabled={busy}
              type="button"
              onClick={() =>
                void send("recover-setup", {
                  expectedAttempt: dialog.snapshot.attempt,
                  expectedGeneration: dialog.snapshot.generation,
                  resolvedRevision: dialog.snapshot.resolvedRevision,
                  memberRef: dialog.snapshot.memberRef,
                  action: "rerun_setup",
                })
              }
            >
              {t("confirmRecovery")}
            </button>
          )}
        </ConfirmDialog>
      ) : null}
    </li>
  );
}

export function DependencyDeclarations({
  slug,
  declarations,
}: {
  slug: string;
  declarations: ProjectDependencyView[];
}): ReactElement {
  const t = useTranslations("dependencies");
  const router = useRouter();

  return (
    <section className="mb-5 space-y-3">
      <header className="flex items-center gap-3">
        <h3 className="font-bold">{t("heading")}</h3>
        <button
          className={buttonClass}
          type="button"
          onClick={() => router.refresh()}
        >
          {t("refresh")}
        </button>
      </header>
      <ul className="space-y-2">
        {declarations.map((row) => (
          <DeclarationRow key={row.id} row={row} slug={slug} />
        ))}
      </ul>
      <Link
        className="underline"
        href={`/projects/${slug}?tab=settings#project-git`}
      >
        {t("reviewGit")}
      </Link>
    </section>
  );
}
