"use client";

import type { View } from "./agent-memory-requests";

import { Button, Input } from "@heroui/react";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { displayIssue, vaultRequest } from "./agent-memory-requests";

export type MemoryPromotionTarget = Readonly<{
  kind: "brain" | "knowledge";
  ownerKind: "project" | "company";
  ownerId: string;
  label: string;
}>;
type Receipt = Readonly<{
  operationId: string;
  proposalId: string;
  proposalHref: string;
}>;

export function AgentMemoryPromotion({
  api,
  note,
  targets,
}: {
  api: string;
  note: Extract<View, { kind: "note" }>;
  targets: readonly MemoryPromotionTarget[];
}) {
  const t = useTranslations("agentVault");
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt>();
  const [failure, setFailure] = useState<"conflict" | "promotionFailed">();
  const chosen = selection === "" ? undefined : targets[Number(selection)];

  async function submit() {
    if (!chosen || busy) return;
    setBusy(true);
    setFailure(undefined);
    const command =
      body ??
      JSON.stringify({
        path: note.path,
        ifRevisionId: note.revisionId,
        ifHash: note.hash,
        requestKey: crypto.randomUUID(),
        ...(title.trim() && { title: title.trim() }),
        target: {
          kind: chosen.kind,
          ownerKind: chosen.ownerKind,
          ownerId: chosen.ownerId,
        },
      });
    setBody(command);
    try {
      setReceipt(
        await vaultRequest<Receipt>(`${api}/promote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: command,
        }),
      );
    } catch (error) {
      setFailure(
        displayIssue(error).code === "CONFLICT"
          ? "conflict"
          : "promotionFailed",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <Button size="sm" variant="secondary" onPress={() => setOpen(true)}>
        {t("promote")}
      </Button>
    );
  if (receipt)
    return (
      <div className="space-y-2 rounded border border-line p-3" role="status">
        <p>{t("promotionPending")}</p>
        <Link className="underline" href={receipt.proposalHref}>
          {t("openPromotion")}
        </Link>
      </div>
    );

  return (
    <form
      className="space-y-3 rounded border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="grid gap-1 text-sm">
        {t("promotionTarget")}
        <select
          className="rounded border border-line bg-paper p-2"
          disabled={busy}
          required
          value={selection}
          onChange={(event) => {
            setSelection(event.target.value);
            setBody(undefined);
          }}
        >
          <option value="">{t("choosePromotionTarget")}</option>
          {targets.map((target, index) => (
            <option key={`${target.kind}:${target.ownerId}`} value={index}>
              {target.label} ·{" "}
              {t(target.kind === "brain" ? "promoteBrain" : "promoteKnowledge")}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        {t("promotionTitle")}
        <Input
          disabled={busy}
          maxLength={256}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setBody(undefined);
          }}
        />
      </label>
      <p className="break-all font-mono text-xs">
        {note.path} · {note.revisionId} · {note.hash}
      </p>
      <blockquote className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-sm">
        {note.content.slice(0, 512)}
      </blockquote>
      {chosen ? (
        <p className="text-sm">
          {t(
            chosen.kind === "brain"
              ? "brainPromotionEffect"
              : "knowledgePromotionEffect",
          )}
        </p>
      ) : null}
      {failure ? <p role="alert">{t(failure)}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          isDisabled={!chosen || busy || failure === "conflict"}
          isPending={busy}
          size="sm"
          type="submit"
        >
          {t("submitPromotion")}
        </Button>
        <Button
          isDisabled={busy}
          size="sm"
          variant="secondary"
          onPress={() => setOpen(false)}
        >
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
