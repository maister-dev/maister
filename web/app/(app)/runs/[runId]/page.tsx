import type { ReactElement } from "react";

import {
  parseFilePaneFile,
  renderRunFilePane,
} from "@/components/runs/run-file-pane";

type PageProps = {
  params: Promise<{ runId: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
};

// The `?file=`-driven workbench pane (FINDING A): the heavy runId-scoped loads
// live in the persistent layout; this child re-renders alone on a `?file=`
// soft-nav. Delegates to the shared run file pane (M35 T3.1).
export default async function RunFilePage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { runId } = await params;
  const { file } = await searchParams;

  return renderRunFilePane({ runId, file: parseFilePaneFile(file) });
}
