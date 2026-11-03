"use client";

import type { ReactElement, FormEvent } from "react";
import type { CompanyPrincipalOption } from "@/lib/company/principal-options";
import type { CompanyAction, ConfirmationClass } from "@/lib/company/types";
import type { KnowledgeDelivery } from "./knowledge-client";

import { Button } from "@heroui/react";
import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import {
  knowledgeDeliveryKey,
  sendKnowledgeRequest,
  knowledgeClientErrorKey,
} from "./knowledge-client";

import { COMPANY_ACTIONS, CONFIRMATION_CLASSES } from "@/lib/company/types";
import {
  companyGrantInputSchema,
  companyGrantSchema,
} from "@/lib/company/grant-types";
import { useFeedback } from "@/components/feedback/feedback-provider";

const grantReceipt = z
  .object({
    companyId: z.string().min(1),
    items: z.array(companyGrantSchema).min(1).max(20),
    nextCursor: z.null(),
  })
  .strict();
const fieldClass =
  "block w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink";

export function CompanyGrantForm({
  principals,
}: {
  principals: readonly CompanyPrincipalOption[];
}): ReactElement {
  const t = useTranslations("knowledge");
  const router = useRouter();
  const feedback = useFeedback();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [actions, setActions] = useState<readonly CompanyAction[]>([]);
  const [classes, setClasses] = useState<readonly ConfirmationClass[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const selected = String(form.get("principal") ?? "");
    const separator = selected.indexOf(":");
    const payload = {
      principalKind: selected.slice(0, separator),
      principalId: selected.slice(separator + 1),
      actions: [...actions].sort(),
      ...(actions.includes("knowledge:confirm")
        ? { confirmationClasses: [...classes].sort() }
        : {}),
    };
    const idempotencyKey = knowledgeDeliveryKey(delivery, payload);
    const parsed = companyGrantInputSchema.safeParse({
      ...payload,
      idempotencyKey,
    });

    if (!parsed.success) {
      setError(t("errorGrantInput"));

      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendKnowledgeRequest(
        "/api/company/grants",
        "POST",
        parsed.data,
        grantReceipt,
      );
      feedback.success({
        message: t("companyAccess"),
        mutationId: idempotencyKey,
      });
      router.push("/settings/company-grants");
    } catch (failure) {
      const key = knowledgeClientErrorKey(failure);
      const message = t(key === "errorConflict" ? "errorPolicyConflict" : key);

      setError(message);
      feedback.error({ message, mutationId: idempotencyKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="max-w-4xl space-y-5 rounded-xl border border-line bg-paper p-5"
      onSubmit={(event) => void submit(event)}
    >
      <p className="text-sm text-mute">{t("grantWarning")}</p>
      <fieldset className="space-y-5" disabled={busy}>
        <label className="block text-sm">
          {t("principal")}
          <select
            required
            aria-label={t("principal")}
            className={`${fieldClass} mt-1`}
            defaultValue=""
            name="principal"
          >
            <option disabled value="">
              {t("choosePrincipal")}
            </option>
            {principals.map((principal) => (
              <option key={principal.value} value={principal.value}>
                {t(`actor.${principal.kind}`)} · {principal.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className="mb-3 text-sm font-semibold">{t("actions")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {COMPANY_ACTIONS.map((action) => (
              <label key={action} className="flex gap-2 text-sm">
                <input
                  checked={actions.includes(action)}
                  type="checkbox"
                  onChange={(event) => {
                    setActions((current) =>
                      event.target.checked
                        ? [...current, action]
                        : current.filter((value) => value !== action),
                    );
                    if (action === "knowledge:confirm" && !event.target.checked)
                      setClasses([]);
                  }}
                />
                {t(`action.${action}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {actions.includes("knowledge:confirm") ? (
          <fieldset>
            <legend className="mb-3 text-sm font-semibold">
              {t("confirmationClasses")}
            </legend>
            <div className="flex flex-wrap gap-4">
              {CONFIRMATION_CLASSES.map((kind) => (
                <label key={kind} className="flex gap-2 text-sm">
                  <input
                    checked={classes.includes(kind)}
                    type="checkbox"
                    onChange={(event) =>
                      setClasses((current) =>
                        event.target.checked
                          ? [...current, kind]
                          : current.filter((value) => value !== kind),
                      )
                    }
                  />
                  {t(`kindValue.${kind}`)}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </fieldset>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-4">
        <Button isDisabled={busy || principals.length === 0} type="submit">
          {t(busy ? "busy" : "grantAccess")}
        </Button>
        <Link className="text-sm underline" href="/settings/company-grants">
          {t("cancel")}
        </Link>
      </div>
    </form>
  );
}
