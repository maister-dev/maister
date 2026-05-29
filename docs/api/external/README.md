# External API references

> **Rule.** Third-party APIs that MAIster consumes live here. Use the
> upstream spec verbatim if it is published; otherwise write a narrow
> OpenAPI 3.0.3 / AsyncAPI 2.6.0 excerpt covering only the surface
> MAIster actually uses. See [`../../CLAUDE.md#r3`](../../CLAUDE.md#r3-api-contracts-are-openapi-303-rest-or-asyncapi-260-events).

## What MAIster consumes today

| External API | Consumed by | Wire | Spec lives at |
| ------------ | ----------- | ---- | -------------- |
| [Agent Client Protocol](https://github.com/agentclientprotocol/protocol) | `supervisor/` → adapter binaries | stdio JSONL (JSON-RPC 2.0) | [`./acp.asyncapi.yaml`](./acp.asyncapi.yaml) — narrow excerpt of the messages MAIster handles. Full spec upstream. |
| [Anthropic Messages API](https://docs.claude.com/en/api/messages) | `claude-agent-acp` (transitive — not called directly by MAIster) | HTTPS | Upstream. MAIster does not call it directly; the adapter binary does. |
| [OpenAI Responses API](https://platform.openai.com/docs/api-reference) | `codex-acp` (transitive — not called directly by MAIster) | HTTPS | Upstream. MAIster does not call it directly; the adapter binary does. |
| Anthropic-API-compatible third-party providers (z.ai GLM, OpenRouter, anyscale, …) | Same as Anthropic — adapter switches base URL via `ANTHROPIC_BASE_URL` | HTTPS | Provider-specific. The shape is Anthropic-compatible; no MAIster-specific divergence. See [ADR-005](../../decisions.md#adr-005-model-routing-env-router-default-ccr-optional). |
| Git CLI (`git worktree`, `git diff`, `git merge`) | `web/lib/worktree.ts` | POSIX subprocess | No contract file — invoked via `child_process`. The exact argv and exit codes used are documented inline in `worktree.ts`. |

## When to add a file here

Add a YAML excerpt when **all** of these are true:

1. MAIster calls the API directly (not through a wrapping library that
   already validates).
2. The upstream spec is not authoritative for the surface MAIster uses,
   or is too big to be useful in code review.
3. A code reviewer would benefit from seeing the contract alongside the
   diff that calls it.

Otherwise, link to upstream from this README and stop.

## What NOT to put here

- Internal MAIster APIs — those live in `../` (supervisor REST + SSE).
- LLM provider docs in prose form — link to upstream, don't restate.
- Provider-specific routing decisions — those are ADRs in
  [`../../decisions.md`](../../decisions.md).
