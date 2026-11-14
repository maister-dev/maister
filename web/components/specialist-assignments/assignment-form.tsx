"use client";

import type { FormEvent, ReactElement } from "react";
import type { SpecialistChoice } from "@/lib/specialist-assignments/workspace-view";

import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  knowledgeClientErrorKey,
  knowledgeDeliveryKey,
  sendKnowledgeRequest,
  type KnowledgeDelivery,
} from "@/components/brain/knowledge-client";
import { specialistAssignmentSchema } from "@/lib/specialist-assignments/types";

const field =
  "mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2 text-ink";

export function SpecialistAssignmentForm({
  choices,
  targets,
}: {
  choices: readonly SpecialistChoice[];
  targets: readonly Readonly<{ id: string; componentIds: readonly string[] }>[];
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [selection, setSelection] = useState("");
  const selectedSpecialist = choices.find(({ id }) => id === selection);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending) return;
    const form = new FormData(event.currentTarget);
    const choice = choices.find(({ id }) => id === form.get("specialist"));
    const selected = String(form.get("component") ?? "");
    const target = targets.find(({ id }) => selected.startsWith(id + "/"));
    const component = target ? selected.slice(target.id.length + 1) : null;

    if (
      !choice ||
      (target &&
        (!choice.supportsStand ||
          !component ||
          !target.componentIds.includes(component)))
    ) {
      setError(knowledge("errorInput"));

      return;
    }
    const request = {
      owner: choice.owner,
      specialistBindingId: choice.id,
      objective: String(form.get("objective") ?? ""),
      expectedOutcome: String(form.get("outcome") ?? ""),
      input: [component ? `Component ID: ${component}` : "", form.get("input")]
        .filter(Boolean)
        .join("\n"),
      targetIds: target ? [target.id] : [],
      inputRefs: [],
      constraints: [],
      verification: target
        ? ["effect", "health"].map((kind) => ({
            kind,
            referenceId: target.id,
            required: true,
          }))
        : [],
    };

    setSending(true);
    setError(null);
    try {
      const assignment = await sendKnowledgeRequest(
        "/api/specialist-assignments",
        "POST",
        {
          ...request,
          idempotencyKey: knowledgeDeliveryKey(delivery, request),
        },
        specialistAssignmentSchema,
      );

      router.push(
        `/specialist-assignments/${encodeURIComponent(assignment.id)}`,
      );
    } catch (error) {
      setError(knowledge(knowledgeClientErrorKey(error)));
      setSending(false);
    }
  }

  return (
    <form
      className="grid gap-4 rounded-xl border border-line bg-paper p-5 sm:grid-cols-2"
      onSubmit={submit}
    >
      <label className="text-sm">
        {t("specialist")}
        <select
          required
          className={field}
          name="specialist"
          value={selection}
          onChange={(event) => setSelection(event.target.value)}
        >
          <option disabled value="">
            {t("selectSpecialist")}
          </option>
          {choices.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {selectedSpecialist?.supportsStand && targets.length ? (
        <label className="text-sm">
          {t("target")}
          <select className={field} name="component">
            <option value="">{t("noTarget")}</option>
            {targets.flatMap(({ id, componentIds }) =>
              componentIds.map((component) => (
                <option key={`${id}/${component}`} value={`${id}/${component}`}>
                  {component} · {id}
                </option>
              )),
            )}
          </select>
        </label>
      ) : null}
      <label className="text-sm sm:col-span-2">
        {t("objective")}
        <input required className={field} maxLength={8000} name="objective" />
      </label>
      <label className="text-sm sm:col-span-2">
        {t("expectedOutcome")}
        <input required className={field} maxLength={4000} name="outcome" />
      </label>
      <label className="text-sm sm:col-span-2">
        {t("input")}
        <textarea className={field} maxLength={7700} name="input" rows={3} />
      </label>
      {error ? (
        <p className="text-sm text-danger sm:col-span-2" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        className="w-fit"
        isPending={sending}
        type="submit"
        variant="primary"
      >
        {t("submit")}
      </Button>
    </form>
  );
}
