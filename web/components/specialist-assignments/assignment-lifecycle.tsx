"use client";

import type { FormEvent, ReactElement } from "react";

import { useState } from "react";
import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import {
  cancelAssignment,
  reopenAssignment,
} from "@/app/(app)/specialist-assignments/actions";
import { knowledgeClientErrorKey } from "@/components/brain/knowledge-client";
import { MaisterError } from "@/lib/errors-core";

export function AssignmentLifecycle({
  assignmentId,
  revision,
  action,
}: {
  assignmentId: string;
  revision: number;
  action: "cancel" | "reopen";
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const reason = String(
      new FormData(event.currentTarget).get("reason") ?? "",
    ).trim();

    setPending(true);
    setError(null);
    try {
      const result =
        action === "cancel"
          ? await cancelAssignment(assignmentId, revision, reason)
          : await reopenAssignment(assignmentId, revision);

      if (!result.ok)
        throw new MaisterError(
          result.code,
          "The assignment action was refused",
        );
      router.refresh();
    } catch (error) {
      setError(knowledge(knowledgeClientErrorKey(error)));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-paper p-5"
      onSubmit={submit}
    >
      {action === "cancel" ? (
        <label className="block text-sm">
          {t("reason")}
          <input
            required
            className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2"
            maxLength={2000}
            name="reason"
          />
        </label>
      ) : null}
      <Button isPending={pending} type="submit" variant="secondary">
        {t(action)}
      </Button>
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
