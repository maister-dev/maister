"use client";

import type { FormEvent, ReactElement } from "react";
import type { KnowledgeDelivery } from "@/components/brain/knowledge-client";

import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  createCoordinatorBinding,
  createSpecialistBinding,
} from "@/app/(app)/settings/specialists/actions";
import {
  knowledgeClientErrorKey,
  knowledgeDeliveryKey,
} from "@/components/brain/knowledge-client";
import { MaisterError } from "@/lib/errors-core";

export function BindingReviewForm({
  companyId,
  bindingKind,
  example,
}: {
  companyId: string;
  bindingKind: "specialist" | "coordinator";
  example: Readonly<Record<string, unknown>>;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);

    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const value: unknown = JSON.parse(
        String(form.get("configuration") ?? ""),
      );

      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new MaisterError(
          "CONFIG",
          "Binding review requires a JSON object",
        );
      const body = { ...value, owner: { kind: "company", companyId } };
      const agentId = String(form.get("agentId") ?? "");
      const binding = {
        ...body,
        idempotencyKey: knowledgeDeliveryKey(delivery, {
          bindingKind,
          agentId,
          body,
        }),
      };
      const result =
        bindingKind === "specialist"
          ? await createSpecialistBinding({ agentId, binding })
          : await createCoordinatorBinding(binding);

      if (!result.ok)
        throw new MaisterError(
          result.code,
          "The reviewed configuration was refused",
        );
      setSaved(true);
      router.refresh();
    } catch (error) {
      setError(
        knowledge(
          error instanceof SyntaxError
            ? "errorInput"
            : knowledgeClientErrorKey(error),
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-4 rounded-xl border border-line bg-paper p-5"
      onSubmit={submit}
    >
      <h2 className="font-semibold">
        {t(bindingKind === "specialist" ? "newBinding" : "newCoordinator")}
      </h2>
      {bindingKind === "specialist" ? (
        <label className="block text-sm">
          {t("qualifiedAgent")}
          <input
            required
            className="mt-1 block w-full rounded border border-line px-3 py-2"
            maxLength={128}
            name="agentId"
          />
        </label>
      ) : null}
      <label className="block text-sm">
        {t("reviewedConfiguration")}
        <textarea
          required
          className="mt-1 block w-full rounded border border-line px-3 py-2 font-mono"
          defaultValue={JSON.stringify(example, null, 2)}
          maxLength={32768}
          name="configuration"
          rows={12}
          spellCheck={false}
        />
      </label>
      <Button isPending={pending} type="submit" variant="primary">
        {t("saveBinding")}
      </Button>
      {saved ? (
        <p className="text-sm" role="status">
          {t("bindingSaved")}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
