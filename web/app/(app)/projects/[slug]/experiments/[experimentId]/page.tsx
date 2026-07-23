import { permanentRedirect } from "next/navigation";

import { resolveLegacyExperimentStudyId } from "@/lib/evaluations/legacy-redirect";
import { getProjectBySlug } from "@/lib/queries/project";

interface PageProps {
  params: Promise<{ slug: string; experimentId: string }>;
}

// ADR-149: a legacy experiment deep-link resolves to its backfilled Study; an
// unknown id (or unknown project) falls back to the evaluations list. The
// experiment detail UI is gone.
export default async function LegacyExperimentDetailPage({
  params,
}: PageProps): Promise<never> {
  const { slug, experimentId } = await params;
  const project = await getProjectBySlug(slug);

  if (project) {
    const studyId = await resolveLegacyExperimentStudyId(
      project.id,
      experimentId,
    );

    if (studyId) {
      permanentRedirect(`/projects/${slug}/evaluations/${studyId}`);
    }
  }

  permanentRedirect(`/projects/${slug}/evaluations`);
}
