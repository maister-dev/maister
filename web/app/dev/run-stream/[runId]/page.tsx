/* dev-only — replaced by Run Detail page in M9 */

import { RunStreamFixture } from "./run-stream-fixture";

type Params = { params: Promise<{ runId: string }> };

export default async function DevRunStreamPage({ params }: Params) {
  const { runId } = await params;

  return (
    <main className="p-6 max-w-4xl mx-auto">
      <header className="mb-4">
        <h1 className="text-xl font-mono">DEV FIXTURE — Run Stream</h1>
        <p className="text-sm text-gray-500">
          Wire-shape verification for `GET /api/runs/[runId]/stream`. Replaced
          by the real Run Detail page in M9. Do NOT link from production UI.
        </p>
        <p className="text-sm mt-2">
          Run ID: <code className="font-mono">{runId}</code>
        </p>
      </header>
      <RunStreamFixture runId={runId} />
    </main>
  );
}
