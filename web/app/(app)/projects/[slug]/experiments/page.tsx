import { permanentRedirect } from "next/navigation";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// ADR-150: the Experiments feature was retired in favor of the Evaluation Lab.
// This route permanently redirects to the project's evaluations page; the legacy
// list UI is gone.
export default async function ProjectExperimentsPage({
  params,
}: PageProps): Promise<never> {
  const { slug } = await params;

  permanentRedirect(`/projects/${slug}/evaluations`);
}
