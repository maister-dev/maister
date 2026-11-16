"use client";

import type { FormEvent, ReactElement } from "react";
import type { KnowledgeDelivery } from "@/components/brain/knowledge-client";
import type { StandInspectionSelector } from "@/lib/stand-operations/scheduled-inspection-types";

import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";

import {
  createStandInspectionSchedule,
  disableStandInspectionSchedule,
} from "@/app/(app)/settings/specialists/actions";
import {
  knowledgeClientErrorKey,
  knowledgeDeliveryKey,
} from "@/components/brain/knowledge-client";
import { MaisterError } from "@/lib/errors-core";

const field = "mt-1 block w-full rounded border border-line bg-paper px-3 py-2";

export function StandInspectionScheduleForm({
  companyId,
  inspectors,
  components,
}: {
  companyId: string;
  inspectors: readonly Readonly<{ id: string; name: string }>[];
  components: readonly StandInspectionSelector[];
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [state, setState] = useState<"idle" | "pending" | "saved" | "refused">(
    "idle",
  );

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (state === "pending") return;
    const form = new FormData(event.currentTarget);
    const appointment = components.find(
      ({ targetId, componentId }) =>
        form.get("component") === `${targetId}/${componentId}`,
    );

    if (!appointment) {
      setState("refused");

      return;
    }
    const body = {
      owner: { kind: "company" as const, companyId },
      specialistBindingId: String(form.get("inspector") ?? ""),
      cronExpr: String(form.get("cron") ?? ""),
      timezone: String(form.get("timezone") ?? ""),
      requestAtLaunch: String(form.get("request") ?? ""),
      standInspection: appointment,
      enabled: true,
    };

    setState("pending");
    try {
      const result = await createStandInspectionSchedule({
        ...body,
        idempotencyKey: knowledgeDeliveryKey(delivery, body),
      });

      if (!result.ok) throw new MaisterError(result.code, "Schedule refused");
      setState("saved");
    } catch (error) {
      setErrorCode(knowledge(knowledgeClientErrorKey(error)));
      setState("refused");
    }
  }

  return (
    <form
      className="space-y-4 rounded-xl border border-line bg-paper p-5"
      onSubmit={submit}
    >
      <h2 className="font-semibold">{t("scheduleInspection")}</h2>
      <label className="block text-sm">
        {t("specialist")}
        <select required className={field} name="inspector">
          {inspectors.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        {t("target")}
        <select required className={field} name="component">
          {components.map(({ targetId, componentId }) => (
            <option
              key={`${targetId}/${componentId}`}
              value={`${targetId}/${componentId}`}
            >
              {componentId} · {targetId}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          {t("inspectionCron")}
          <input required className={field} maxLength={128} name="cron" />
        </label>
        <label className="block text-sm">
          {t("inspectionTimezone")}
          <input
            required
            className={field}
            defaultValue="UTC"
            maxLength={64}
            name="timezone"
          />
        </label>
      </div>
      <label className="block text-sm">
        {t("inspectionRequest")}
        <textarea
          required
          className={field}
          maxLength={8000}
          name="request"
          rows={3}
        />
      </label>
      <Button isPending={state === "pending"} type="submit" variant="primary">
        {t("enableInspection")}
      </Button>
      {state === "saved" ? (
        <p className="text-sm" role="status">
          {t("inspectionSaved")}
        </p>
      ) : null}
      {state === "refused" ? (
        <p className="text-sm text-danger" role="alert">
          {errorCode ?? t("inspectionRefused")}
        </p>
      ) : null}
    </form>
  );
}

export function DisableStandInspection({
  companyId,
  scheduleId,
  revision,
}: {
  companyId: string;
  scheduleId: string;
  revision: number;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disable(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const outcome = await disableStandInspectionSchedule({
        companyId,
        scheduleId,
        revision,
      });

      if (!outcome.ok)
        throw new MaisterError(outcome.code, "Unable to disable this schedule");
    } catch (error) {
      setError(knowledge(knowledgeClientErrorKey(error)));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        isPending={pending}
        size="sm"
        variant="secondary"
        onPress={disable}
      >
        {t("disableInspection")}
      </Button>
      {error ? (
        <span className="text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
