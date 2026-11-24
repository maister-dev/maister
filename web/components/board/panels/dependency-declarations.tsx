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
const coordinateFields = ["source", "version", "path"] as const;

type CoordinateField = (typeof coordinateFields)[number];
type EditPin = {
  expectedGeneration: number;
  source: string;
  version: string;
  path?: string;
};
type Command =
  | { action: "edit"; body: EditPin }
  | { action: "retry" | "recover-setup"; body: Record<string, unknown> };

async function reconcileEdit(
  slug: string,
  declarationId: string,
  pin: EditPin,
): Promise<"editConfirmed" | "conflict" | "requestFailed"> {
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(slug)}/packages`,
      { cache: "no-store" },
    );

    if (!response.ok) return "requestFailed";
    const { declarations }: { declarations: ProjectDependencyView[] } =
      await response.json();
    const current = declarations.find(
      (entry) => entry.id === declarationId && entry.kind === "package",
    );

    if (!current) return "conflict";
    const samePin =
      current.source === pin.source &&
      current.version === pin.version &&
      current.path === (pin.path ?? null);

    if (
      samePin &&
      (current.generation === pin.expectedGeneration + 1 ||
        current.generation === pin.expectedGeneration)
    )
      return "editConfirmed";

    return current.generation === pin.expectedGeneration
      ? "requestFailed"
      : "conflict";
  } catch {
    return "requestFailed";
  }
}

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
  const [invalidField, setInvalidField] = useState<CoordinateField | null>(
    null,
  );
  const base = `/api/projects/${encodeURIComponent(slug)}/dependency-declarations/${encodeURIComponent(row.id)}`;

  async function verifyEdit(pin: EditPin): Promise<void> {
    const outcome = await reconcileEdit(slug, row.id, pin);

    if (outcome !== "requestFailed") setDialog(null);
    setNotice(t(outcome));
    router.refresh();
  }

  async function send({ action, body }: Command): Promise<void> {
    setBusy(true);
    setNotice(null);
    setInvalidField(null);
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
        const failure = await response.json();

        if (
          action === "edit" &&
          failure.details?.reason === "stale_generation"
        ) {
          await verifyEdit(body);

          return;
        }
        setDialog(null);
        setNotice(
          t(
            failure.details?.reason === "operation_busy"
              ? "publicationBusy"
              : failure.details?.reason === "setup_owner_live"
                ? "setupLive"
                : "conflict",
          ),
        );
      } else if (response.status === 422 && action === "edit") {
        const failure = await response.json();
        const field = coordinateFields.find(
          (key) => key === failure.details?.field,
        );

        if (field) setInvalidField(field);
        else setNotice(t("refused"));
      } else setNotice(t("refused"));
      router.refresh();
    } catch {
      if (action === "edit") await verifyEdit(body);
      else setNotice(t("requestFailed"));
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

    void send({
      action: "edit",
      body: {
        expectedGeneration,
        source: String(data.get("source") ?? "").trim(),
        version: String(data.get("version") ?? "").trim(),
        ...(path ? { path } : {}),
      },
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
            onClick={() => {
              setInvalidField(null);
              setNotice(null);
              setDialog({ kind: "edit", snapshot: row });
            }}
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
              void send({
                action: "retry",
                body: {
                  expectedGeneration: row.generation,
                  expectedAttempt: row.attempt,
                },
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
              {coordinateFields.map((field) => (
                <label key={field} className="block">
                  {t(field)}
                  <input
                    aria-describedby={
                      field === invalidField
                        ? `dependency-${row.id}-error`
                        : undefined
                    }
                    aria-invalid={field === invalidField || undefined}
                    className={fieldClass}
                    defaultValue={dialog.snapshot[field] ?? ""}
                    name={field}
                    required={field !== "path"}
                    onChange={() => {
                      if (field === invalidField) setInvalidField(null);
                    }}
                  />
                </label>
              ))}
              {invalidField && (
                <p id={`dependency-${row.id}-error`} role="alert">
                  {t(`validation.${invalidField}`)}
                </p>
              )}
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
                void send({
                  action: "recover-setup",
                  body: {
                    expectedAttempt: dialog.snapshot.attempt,
                    expectedGeneration: dialog.snapshot.generation,
                    resolvedRevision: dialog.snapshot.resolvedRevision,
                    memberRef: dialog.snapshot.memberRef,
                    action: "rerun_setup",
                  },
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
