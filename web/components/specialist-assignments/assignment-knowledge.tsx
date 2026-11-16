"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { Button } from "@heroui/react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { proposeAssignmentKnowledge } from "@/app/(app)/specialist-assignments/actions";
import { knowledgeClientErrorKey } from "@/components/brain/knowledge-client";
import { MaisterError } from "@/lib/errors-core";

export function AssignmentKnowledge({
  assignmentId,
}: {
  assignmentId: string;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const [pending, setPending] = useState(false);
  const [proposals, setProposals] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await proposeAssignmentKnowledge(assignmentId);

      if (!result.ok)
        throw new MaisterError(
          result.code,
          "The knowledge proposal was refused",
        );
      setProposals(result.proposalIds);
    } catch (error) {
      setError(knowledge(knowledgeClientErrorKey(error)));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-line bg-paper p-5">
      <h2 className="font-semibold">{t("writeBack")}</h2>
      <Button isPending={pending} variant="secondary" onPress={submit}>
        {t("submitDrafts")}
      </Button>
      {proposals?.length ? (
        <ul aria-live="polite" className="space-y-2 text-sm">
          {proposals.map((id, index) => (
            <li key={id}>
              <Link
                className="underline"
                href={`/knowledge/proposals/${encodeURIComponent(id)}`}
              >
                {t("openProposal", { number: index + 1 })}
              </Link>
            </li>
          ))}
        </ul>
      ) : proposals ? (
        <p className="text-sm" role="status">
          {t("noDrafts")}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
