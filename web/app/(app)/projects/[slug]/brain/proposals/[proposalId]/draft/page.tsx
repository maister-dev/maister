import type { ReactElement } from "react";

import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { requireProjectAction } from "@/lib/authz";
import { isBrainSchemaApplied } from "@/lib/brain/guard";
import { getBrainProposal } from "@/lib/brain/proposals";
import { getAuthoredCapability } from "@/lib/catalog/authored-service";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";

async function readProposalDraft(slug: string, proposalId: string) {
  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) notFound();

  try {
    const { user } = await requireProjectAction(project.id, "readBrain");
    const db = getDb();

    if (!(await isBrainSchemaApplied(db))) notFound();
    return await db.transaction(async (tx) => {
      const proposal = await getBrainProposal(tx, project.id, proposalId, {
        type: "user",
        id: user.id,
      });

      if (!proposal.authoredDraftId || proposal.status !== "applied")
        notFound();

      const { capability, revisions } = await getAuthoredCapability({
        projectSlug: slug,
        capId: proposal.authoredDraftId,
        db: tx,
      });
      const { kind } = capability;

      if (
        (kind !== "rule" && kind !== "skill") ||
        kind !== proposal.kind ||
        capability.archivedAt
      )
        notFound();
      const revision = revisions.find(
        ({ revisionNumber }) => revisionNumber === 1,
      );

      if (!revision) notFound();

      return { kind, revision };
    });
  } catch (error) {
    if (
      isMaisterError(error) &&
      (error.code === "UNAUTHORIZED" ||
        error.code === "PRECONDITION" ||
        error.code === "CONFIG")
    )
      notFound();
    throw error;
  }
}

export default async function ProposalDraftPage({
  params,
}: {
  params: Promise<{ slug: string; proposalId: string }>;
}): Promise<ReactElement> {
  const { slug, proposalId } = await params;
  const { kind, revision } = await readProposalDraft(slug, proposalId);
  const [flow, review, knowledge] = await Promise.all([
    getTranslations("flows"),
    getTranslations("inbox.reviews"),
    getTranslations("knowledge"),
  ]);
  const { markdown, content } = revision.body;
  const source =
    typeof markdown === "string"
      ? markdown
      : typeof content === "string"
        ? content
        : JSON.stringify(revision.body, null, 2);
  const query = new URLSearchParams({ proposalKind: "brain", proposalId });

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <Link className="text-sm underline" href={`/knowledge/reviews?${query}`}>
        {review("preview")}
      </Link>
      <div>
        <h1 className="break-words text-2xl font-semibold">{revision.title}</h1>
        <p className="text-sm text-mute">
          {flow(`packageFileKind.${kind}`)} ·{" "}
          {flow(`lifecycle.${revision.lifecycle}`)} · {knowledge("revision")}{" "}
          {revision.revisionNumber}
        </p>
      </div>
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-paper p-4 text-sm">
        {source}
      </pre>
    </section>
  );
}
