import type { ReactElement } from "react";

import { ScratchDialog } from "@/components/scratch/scratch-dialog";

type PageProps = {
  params: Promise<{ runId: string }>;
};

export default async function ScratchRunPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { runId } = await params;

  return (
    <div className="mx-auto max-w-[1280px]">
      <ScratchDialog runId={runId} />
    </div>
  );
}
