"use client";

import type { FormEvent, ReactElement } from "react";
import type { KnowledgeOwnerChoice } from "@/lib/brain/knowledge-owner-selection";
import type {
  KnowledgeRecordDto,
  KnowledgeWitnessDto,
} from "@/lib/brain/knowledge-read-types";
import type { KnowledgeDelivery } from "./knowledge-client";

import { Button, Input } from "@heroui/react";
import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  knowledgeDeliveryKey,
  sendKnowledgeRequest,
  knowledgeClientErrorKey,
} from "./knowledge-client";

import { knowledgeOwnerSelection } from "@/lib/brain/knowledge-owner-selection";
import { KNOWLEDGE_KINDS } from "@/lib/brain/record-types";
import {
  knowledgeProposalInputSchema,
  knowledgeMutationReceiptSchema,
} from "@/lib/brain/knowledge-write-types";
import { knowledgeWitnessSchema } from "@/lib/brain/knowledge-read-types";
import { MaisterError } from "@/lib/errors-core";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { useIsClient } from "@/lib/use-is-client";

const fieldClass =
  "block w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink";

export function KnowledgeProposalForm({
  owners,
  record,
  inheritedOwner,
}: {
  owners: readonly KnowledgeOwnerChoice[];
  record?: KnowledgeRecordDto;
  inheritedOwner?: KnowledgeOwnerChoice;
}): ReactElement {
  const t = useTranslations("knowledge");
  const router = useRouter();
  const feedback = useFeedback();
  const ready = useIsClient();
  const captureDelivery = useRef<KnowledgeDelivery | null>(null);
  const proposalDelivery = useRef<KnowledgeDelivery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedOwner, setSelectedOwner] = useState("");
  const [witnessId, setWitnessId] = useState("");
  const [witness, setWitness] = useState<KnowledgeWitnessDto | null>(null);
  const [witnessStatus, setWitnessStatus] = useState<
    "idle" | "loading" | "unavailable"
  >("idle");

  async function inspectWitness() {
    if (!witnessId.trim() || witnessStatus === "loading") return;
    setWitnessStatus("loading");
    setWitness(null);
    try {
      const response = await fetch(
        `/api/knowledge/witnesses/${encodeURIComponent(witnessId.trim())}`,
        { cache: "no-store" },
      );
      const parsed = knowledgeWitnessSchema.safeParse(await response.json());

      if (
        !response.ok ||
        !parsed.success ||
        parsed.data.availability !== "available"
      ) {
        setWitnessStatus("unavailable");

        return;
      }
      setWitness(parsed.data);
      setWitnessStatus("idle");
    } catch {
      setWitnessStatus("unavailable");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);

    setBusy(true);
    setError(null);
    let mutationId = "knowledge-proposal-input";

    try {
      const owner =
        record?.owner ??
        inheritedOwner?.owner ??
        knowledgeOwnerSelection(String(form.get("owner") ?? ""));

      if (!owner)
        throw new MaisterError("CONFIG", "Select the knowledge owner");
      const sourceText = String(form.get("sourceText") ?? "");
      const sourceTitle = String(form.get("sourceTitle") ?? "");
      const evidence =
        record?.evidence.flatMap((entry) =>
          "witness" in entry
            ? [
                {
                  relation: entry.relation,
                  reference: {
                    kind: "witness" as const,
                    id: entry.witness.id,
                    ...(entry.witness.sourceVersion === null
                      ? {}
                      : { version: entry.witness.sourceVersion }),
                    ...(entry.witness.sha256 === null
                      ? {}
                      : { sha256: entry.witness.sha256 }),
                  },
                },
              ]
            : [],
        ) ?? [];

      if (
        witness &&
        !evidence.some((entry) => entry.reference.id === witness.id)
      ) {
        evidence.push({
          relation:
            form.get("witnessRelation") === "supports"
              ? "supports"
              : "derived_from",
          reference: {
            kind: "witness",
            id: witness.id,
            ...(witness.sourceVersion && { version: witness.sourceVersion }),
            ...(witness.sha256 && { sha256: witness.sha256 }),
          },
        });
      }

      if (sourceText !== "") {
        if (!sourceTitle.trim())
          throw new MaisterError(
            "CONFIG",
            "A captured source requires a title",
          );
        const capture = { owner, title: sourceTitle, content: sourceText };
        const idempotencyKey = knowledgeDeliveryKey(captureDelivery, capture);

        mutationId = idempotencyKey;
        const witness = await sendKnowledgeRequest(
          "/api/knowledge/sources",
          "POST",
          { ...capture, idempotencyKey },
          knowledgeWitnessSchema,
        );

        evidence.push({
          relation: "supports",
          reference: {
            kind: "witness",
            id: witness.id,
            ...(witness.sourceVersion === null
              ? {}
              : { version: witness.sourceVersion }),
            ...(witness.sha256 === null ? {} : { sha256: witness.sha256 }),
          },
        });
      }
      const missing = String(form.get("missingReason") ?? "").trim();
      const missingEvidence = [
        ...(record?.missingEvidence.filter((_entry, index) =>
          form.getAll("retainedMissing").includes(String(index)),
        ) ?? []),
        ...(missing ? [{ state: "absent" as const, reason: missing }] : []),
      ];

      if (evidence.length === 0 && missingEvidence.length === 0)
        throw new MaisterError(
          "CONFIG",
          "Describe the missing evidence explicitly",
        );
      const limitation = String(form.get("limitations") ?? "").trim();
      const draft = {
        title: String(form.get("title") ?? ""),
        kind: String(form.get("kind") ?? ""),
        assertion: String(form.get("assertion") ?? ""),
        basis: String(form.get("basis") ?? ""),
        evidence,
        missingEvidence,
        limitations: [
          ...(record?.limitations.filter((_entry, index) =>
            form.getAll("retainedLimitations").includes(String(index)),
          ) ?? []),
          ...(limitation === "" ? [] : [limitation]),
        ],
      };
      const content = record
        ? {
            ...draft,
            change: "correct" as const,
            recordId: record.id,
            expectedRevision: record.revision,
          }
        : { ...draft, change: "add" as const, owner };
      const idempotencyKey = knowledgeDeliveryKey(proposalDelivery, {
        content,
      });

      mutationId = idempotencyKey;
      const input = knowledgeProposalInputSchema.safeParse({
        content,
        idempotencyKey,
      });

      if (!input.success)
        throw new MaisterError(
          "CONFIG",
          "Check the bounded knowledge proposal fields",
        );
      const receipt = await sendKnowledgeRequest(
        "/api/knowledge/proposals",
        "POST",
        input.data,
        knowledgeMutationReceiptSchema,
      );

      feedback.success({ message: t("title"), mutationId });
      router.push(`/knowledge/proposals/${encodeURIComponent(receipt.id)}`);
    } catch (failure) {
      const message = t(knowledgeClientErrorKey(failure));

      setError(message);
      feedback.error({ message, mutationId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="max-w-3xl space-y-5 rounded-xl border border-line bg-paper p-5"
      onSubmit={(event) => void submit(event)}
    >
      <fieldset className="space-y-4" disabled={!ready || busy}>
        {record ? (
          <p className="text-sm text-mute">{t("supportRetained")}</p>
        ) : inheritedOwner ? (
          <p className="text-sm">
            <span className="text-mute">{t("owner")}</span> ·{" "}
            {inheritedOwner.projectName}
          </p>
        ) : (
          <label className="block text-sm">
            {t("owner")}
            <select
              required
              aria-label={t("owner")}
              className={`${fieldClass} mt-1`}
              name="owner"
              value={selectedOwner}
              onChange={(event) => setSelectedOwner(event.target.value)}
            >
              <option disabled value="">
                {t("chooseOwner")}
              </option>
              {owners.map((owner) => (
                <option key={owner.value} value={owner.value}>
                  {owner.projectName ?? t("company")}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-sm">
          {t("titleLabel")}
          <Input
            required
            defaultValue={record?.title ?? ""}
            maxLength={256}
            name="title"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            {t("kind")}
            <select
              aria-label={t("kind")}
              className={`${fieldClass} mt-1`}
              defaultValue={record?.kind ?? "assertion"}
              name="kind"
            >
              {KNOWLEDGE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kindValue.${kind}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            {t("basis")}
            <select
              aria-label={t("basis")}
              className={`${fieldClass} mt-1`}
              defaultValue={record?.basis ?? "inferred"}
              name="basis"
            >
              {["inferred", "observed", "unknown"].map((basis) => (
                <option key={basis} value={basis}>
                  {t(`state.${basis}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-sm">
          {t("assertion")}
          <textarea
            required
            aria-label={t("assertion")}
            className={`${fieldClass} mt-1`}
            defaultValue={record?.assertion ?? ""}
            maxLength={32000}
            name="assertion"
            rows={7}
          />
        </label>
        <div className="space-y-2 rounded-lg border border-line p-3">
          <label className="block text-sm">
            {t("witnessReference")}
            <Input
              disabled={witnessStatus === "loading"}
              maxLength={128}
              value={witnessId}
              onChange={(event) => {
                setWitnessId(event.target.value);
                setWitness(null);
                setWitnessStatus("idle");
              }}
            />
          </label>
          <Button
            isDisabled={!witnessId.trim()}
            isPending={witnessStatus === "loading"}
            type="button"
            variant="secondary"
            onPress={() => void inspectWitness()}
          >
            {t("inspectWitness")}
          </Button>
          {witnessStatus === "unavailable" ? (
            <p role="alert">{t("unavailable")}</p>
          ) : null}
          {witness ? (
            <div className="space-y-2 text-sm">
              <Link
                className="underline"
                href={`/knowledge/witnesses/${encodeURIComponent(witness.id)}`}
              >
                {witness.sourceVersion ?? witness.id}
              </Link>
              <label className="block">
                {t("evidenceRelation")}
                <select className={fieldClass} name="witnessRelation">
                  <option value="derived_from">
                    {t("relation.derived_from")}
                  </option>
                  <option value="supports">{t("relation.supports")}</option>
                </select>
              </label>
            </div>
          ) : null}
        </div>
        <p className="text-sm text-mute">{t("capturedHint")}</p>
        <label className="block text-sm">
          {t("sourceTitle")}
          <Input maxLength={256} name="sourceTitle" />
        </label>
        <label className="block text-sm">
          {t("sourceText")}
          <textarea
            aria-label={t("sourceText")}
            className={`${fieldClass} mt-1`}
            maxLength={32000}
            name="sourceText"
            rows={5}
          />
        </label>
        <p className="text-sm text-mute">{t("missingHint")}</p>
        <label className="block text-sm">
          {t("missingReason")}
          <textarea
            aria-label={t("missingReason")}
            className={`${fieldClass} mt-1`}
            maxLength={1000}
            name="missingReason"
            rows={2}
          />
        </label>
        {record?.missingEvidence.map((entry, index) => (
          <label
            key={`missing:${index}`}
            className="flex items-start gap-2 text-sm"
          >
            <input
              defaultChecked
              name="retainedMissing"
              type="checkbox"
              value={index}
            />
            <span>
              {t("retainMissing")}: {entry.reason}
            </span>
          </label>
        ))}
        {record?.limitations.map((entry, index) => (
          <label
            key={`limitation:${index}`}
            className="flex items-start gap-2 text-sm"
          >
            <input
              defaultChecked
              name="retainedLimitations"
              type="checkbox"
              value={index}
            />
            <span>
              {t("retainLimitation")}: {entry}
            </span>
          </label>
        ))}
        <label className="block text-sm">
          {t("limitationsInput")}
          <textarea
            aria-label={t("limitations")}
            className={`${fieldClass} mt-1`}
            maxLength={1000}
            name="limitations"
            rows={3}
          />
        </label>
      </fieldset>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-4">
        <Button
          isDisabled={busy || (!record && owners.length === 0)}
          type="submit"
        >
          {t(busy ? "busy" : "submitProposal")}
        </Button>
        <Link
          className="text-sm underline"
          href={
            record
              ? `/knowledge/${encodeURIComponent(record.id)}`
              : "/knowledge"
          }
        >
          {t("cancel")}
        </Link>
      </div>
    </form>
  );
}
