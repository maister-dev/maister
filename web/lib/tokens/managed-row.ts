// ADR-168 D3, mirrored for both render sides. `lib/tokens/lifecycle.ts` is
// server-only, so the client panels cannot import the policy from there — but
// this predicate is also called while a SERVER component renders a token row,
// which is why it may not live in a `"use client"` module either: React refuses
// to invoke a client export from the server, and the Integrations tab crashed
// on any project that had at least one token. Plain module, importable by both.
//
// A non-managed token is machine-minted and run-bound — `issueOrchestratorRunToken`
// mints token_kind='project' named `orchestrator-run:<runId>`, and listTokens
// filters on project_id alone, so those rows DO render in these tables today.
// This only withholds the affordance; the server refuses the PATCH regardless.
const RESERVED_TOKEN_NAME_PATTERN = /^(orchestrator-run|agent-run):/iu;

export function isManagedTokenRow(token: {
  kind: string;
  name: string;
}): boolean {
  return (
    token.kind !== "agent" && !RESERVED_TOKEN_NAME_PATTERN.test(token.name)
  );
}
