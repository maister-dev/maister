"use client";

import type { LibrarianMessageDto } from "@/lib/librarian/view";

import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslations } from "next-intl";

import {
  FormFieldControl,
  coerceFormFieldValue,
} from "@/components/board/hitl-decision-controls";

type PrivateQuestion = NonNullable<LibrarianMessageDto["card"]>;

export function LibrarianQuestion({
  card,
  onSubmitted,
}: {
  card: PrivateQuestion;
  onSubmitted: () => Promise<void>;
}): ReactElement {
  const t = useTranslations("librarian");
  const [values, setValues] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const idPrefix = "private-question-" + card.id;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || card.state !== "open") return;
    setBusy(true);
    setError(false);
    try {
      const answer: Record<string, unknown> = Object.create(null);

      for (const field of card.schema.fields) {
        const raw = values.get(field.name) ?? "";

        if (!field.required && raw === "") continue;
        if (field.type === "boolean" && !["true", "false"].includes(raw))
          throw new Error("Invalid boolean answer");
        answer[field.name] =
          field.type === "object" || field.type === "array"
            ? JSON.parse(raw)
            : coerceFormFieldValue(field.type, raw);
      }
      const response = await fetch(
        "/api/librarian/cards/" + encodeURIComponent(card.id) + "/answer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        },
      );

      if (!response.ok) setError(true);
      await onSubmitted();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-labelledby={idPrefix}
      className="flex flex-col gap-3"
      data-testid="librarian-private-question"
      onSubmit={submit}
    >
      <p className="m-0 font-medium" id={idPrefix}>
        {card.question}
      </p>
      {card.state === "open" ? (
        <>
          {card.schema.fields.map((field) => (
            <FormFieldControl
              key={field.name}
              disabled={busy}
              field={field}
              idPrefix={idPrefix}
              labels={{
                jsonFieldParsed: t("questionJsonParsed"),
                jsonFieldPlainText: t("questionPlainText"),
              }}
              placeholder={field.label ?? field.name}
              value={values.get(field.name) ?? ""}
              onChange={(value) =>
                setValues((current) => new Map(current).set(field.name, value))
              }
            />
          ))}
          <button
            className="self-start rounded border border-line px-3 py-1"
            disabled={
              busy ||
              card.schema.fields.some(
                (field) => field.required && !values.get(field.name)?.trim(),
              )
            }
            type="submit"
          >
            {t("questionSubmit")}
          </button>
        </>
      ) : (
        <>
          {card.answer && (
            <dl>
              {Object.entries(card.answer).map(([name, value]) => (
                <div key={name}>
                  <dt>
                    {card.schema.fields.find((field) => field.name === name)
                      ?.label ?? name}
                  </dt>
                  <dd>
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <span role="status">
            {t(
              card.state === "accepted"
                ? "questionAccepted"
                : card.state === "delivered"
                  ? "questionDelivered"
                  : card.state === "closed"
                    ? "questionClosed"
                    : "questionParking",
            )}
          </span>
        </>
      )}
      {error && <p role="alert">{t("questionError")}</p>}
    </form>
  );
}
