"use client";

import type { LibrarianMessageDto } from "@/lib/librarian/view";

import { Button } from "@heroui/react";
import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslations } from "next-intl";

import {
  FormFieldControl,
  coerceFormFieldValue,
} from "@/components/board/hitl-decision-controls";
import { apiErrorText, readApiErrorBody } from "@/lib/api-error";

type PrivateQuestion = NonNullable<LibrarianMessageDto["card"]>;

export function LibrarianQuestion({
  card,
  onSubmitted,
}: {
  card: PrivateQuestion;
  onSubmitted: () => Promise<void>;
}): ReactElement {
  const t = useTranslations("librarian");
  const tApiErrors = useTranslations("apiErrors");
  const [values, setValues] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idPrefix = "private-question-" + card.id;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || card.state !== "open") return;
    setBusy(true);
    setError(null);
    try {
      const answer: Record<string, unknown> = Object.create(null);

      try {
        for (const field of card.schema.fields) {
          const raw = values.get(field.name) ?? "";

          if (!field.required && raw === "") continue;
          if (field.type === "boolean" && !["true", "false"].includes(raw)) {
            setError(t("questionError"));

            return;
          }
          answer[field.name] =
            field.type === "object" || field.type === "array"
              ? JSON.parse(raw)
              : coerceFormFieldValue(field.type, raw);
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        setError(t("questionError"));

        return;
      }
      const response = await fetch(
        "/api/librarian/cards/" + encodeURIComponent(card.id) + "/answer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        },
      );

      if (!response.ok) {
        const failure = await readApiErrorBody(response);
        const reason = failure?.details?.reason;

        if (reason === "question_closed" || reason === "not_found") {
          setError(t("questionUnavailable"));
          await onSubmitted();
        } else if (failure?.code === "CONFLICT") {
          setError(t("questionChanged"));
          await onSubmitted();
        } else {
          setError(
            failure?.code === "CONFIG" || reason === "json_body_too_large"
              ? t("questionError")
              : apiErrorText(failure, tApiErrors),
          );
        }

        return;
      }
      await onSubmitted();
    } catch {
      setError(tApiErrors("requestFailed"));
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
          <Button
            className="self-start"
            isDisabled={
              busy ||
              card.schema.fields.some(
                (field) => field.required && !values.get(field.name)?.trim(),
              )
            }
            isPending={busy}
            size="sm"
            type="submit"
          >
            {t("questionSubmit")}
          </Button>
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
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
