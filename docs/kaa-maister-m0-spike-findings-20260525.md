# M0 Spike Findings (2026-05-25)

> Outcome of the 0.5-day pre-code spike gate defined in `.ai-factory/ROADMAP.md`
> and `docs/kaa-maister-design-20260525-acp-revision.md`. All 4 verification
> items resolved; one new cost-related finding emerged.

## Summary

| Item | Status | Verdict |
|---|---|---|
| M0.1 Exact ACP package name + version | ✅ Verified | `@agentclientprotocol/claude-agent-acp@0.37.0` + `@agentclientprotocol/codex-acp@0.0.44` + `@agentclientprotocol/sdk@0.22.1` (all Apache-2.0, single canonical org) |
| M0.2 `claude --resume <session-id>` cross-process | ✅ Verified live | Works. Session JSONL at `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`, append-only, survives parent process kill |
| M0.3 Codex ACP parity | ✅ Verified | Codex CLI has NO native ACP. Use `@agentclientprotocol/codex-acp` adapter (bundles patched `@openai/codex` 0.128+). Supervisor spawn dispatches on `executor.agent` |
| M0.4 CCR + z.ai GLM | ✅ Verified by docs | `@musistudio/claude-code-router@2.0.0` (MIT). z.ai exposes Anthropic-compatible endpoint at `https://api.z.ai/api/anthropic` — **CCR not required** for single-provider GLM; env-router suffices |
| ⚠ NEW: cache-creation cost per resume | 🔴 Unresolved | Each cross-process resume rebuilds the full ~45-50k-token cache (~$0.28/respawn). Reinforces the 30-min keep-alive design — too-eager checkpoint is expensive |

## Detailed findings

### M0.1 ACP packages

Canonical npm org is **`@agentclientprotocol`** (GitHub: `github.com/agentclientprotocol`). Maintained by Zed core team (benbrandt, aguzubiaga, cirwin/Conrad Irwin).

| Package | Version | License | Binary | Key deps |
|---|---|---|---|---|
| `@agentclientprotocol/sdk` | 0.22.1 | Apache-2.0 | — (library) | none core |
| `@agentclientprotocol/claude-agent-acp` | 0.37.0 (2026-05-21) | Apache-2.0 | `claude-agent-acp` | `@agentclientprotocol/sdk@0.22.1`, `@anthropic-ai/claude-agent-sdk@0.3.146`, `zod` |
| `@agentclientprotocol/codex-acp` | 0.0.44 (2026-05-11) | Apache-2.0 | `codex-acp` | `@agentclientprotocol/sdk@^0.21.0`, `@openai/codex@^0.128.0`, `diff`, `open`, `vscode-jsonrpc` |

**Resolution of name ambiguity:** the user-referenced URL
`github.com/agentclientprotocol/claude-agent-acp` is correct and canonical.
`@zed-industries/claude-code-acp` was a deprecated/old name — the maintainers
moved the org to `agentclientprotocol` to position it as a vendor-neutral
standard (same org also publishes `codex-acp`, `gemini-acp`, etc.).

**Underlying SDK:** the ACP adapter does NOT wrap the `@anthropic-ai/claude-code`
CLI package — it wraps `@anthropic-ai/claude-agent-sdk` (the programmatic
SDK). The CLI and the SDK are separate npm packages. This matters for
supervisor: we don't spawn `claude` CLI; we spawn `claude-agent-acp` which
talks to the SDK internally.

### M0.2 Cross-process resume — live test

**Test procedure** (executed 2026-05-25 18:23-18:24, two separate processes):

```bash
# Process 1: create session with explicit UUID
SESSION_ID=398e0a02-752c-491f-bb85-cf0e79043667
cd /tmp && claude -p --session-id "$SESSION_ID" --output-format json \
  "Remember the secret word is ALBATROSS-42. Reply only with: acknowledged"
# → "acknowledged" (2.3s, 6 input + 45464 cache_creation + 9 output tokens, $0.28)

# Process 2: resume from a fresh process (Process 1 already exited)
cd /tmp && claude -p --resume "$SESSION_ID" --output-format json \
  "What is the secret word I told you? Reply with just the word."
# → "ALBATROSS-42" (2.8s, 6 input + 47368 cache_creation + 13 output tokens, $0.30)
```

✅ Resume works across processes. Context preserved.

**Session storage:**
- Location: `~/.claude/projects/<cwd-encoded>/<session-uuid>.jsonl`
- `<cwd-encoded>` = working directory with `/` replaced by `-` (e.g. `/private/tmp` → `-private-tmp`)
- Permissions: `drwx------` on `~/.claude/projects/` directories — user-private
- Format: append-only JSONL
- Discriminated record types observed: `queue-operation`, `assistant`, `last-prompt`, plus standard message records with `role` + `content`
- File grew 0→82KB after the two-turn conversation above

**Implication for `supervisor/`:**
- `runs.acp_session_id` IS the resume handle — no separate checkpoint format needed; Claude Code's own JSONL store IS the checkpoint
- On crash recovery, supervisor only needs to verify the JSONL file exists; respawn with `--resume <uuid>` works
- Session subdir keyed by cwd → MAIster must invoke `claude` from the worktree path, not from anywhere else, or sessions will fragment

### M0.3 Codex ACP parity

Codex CLI itself has NO `--acp` flag and no `acp-server` subcommand. It does
have:
- `codex resume [SESSION_ID] [PROMPT]` — native resume by UUID
- `codex exec [PROMPT]` — non-interactive run
- `codex mcp-server` — Codex exposed as MCP server (not ACP)
- `codex app-server` — experimental websocket interface

ACP integration is via the **separate adapter** `@agentclientprotocol/codex-acp`
which:
- Ships its own pinned `@openai/codex ^0.128.0` as a direct npm dep (avoids
  drift against host's globally installed codex)
- Speaks JSONRPC over stdio (per the ACP spec)
- Exposes the same `session/update`, `session/request_permission`, etc.
  surface as `claude-agent-acp`

**Supervisor spawn pattern (verified architecturally):**

```typescript
// supervisor/src/spawn.ts
const bin = executor.agent === 'claude'
  ? 'claude-agent-acp'   // from @agentclientprotocol/claude-agent-acp
  : 'codex-acp';         // from @agentclientprotocol/codex-acp

spawn(bin, [], {
  cwd: worktreePath,
  env: { ...process.env, ...executor.env },
  stdio: ['pipe', 'pipe', 'inherit'],
});
```

Both adapters share the same wire protocol → ACP-client code in supervisor
is agent-agnostic; only the binary name differs.

⚠ Codex adapter is at v0.0.44 (breaking changes likely per maintainer notes).
Pin exact version in `supervisor/package.json`. Claude adapter at v0.37.0 is
also young but more mature.

### M0.4 CCR + z.ai GLM routing

Two distinct routing models, **both viable**:

**(a) Direct env-router (simpler, recommended for POC)**:

```bash
ANTHROPIC_AUTH_TOKEN=<z.ai-key> \
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic \
claude -p "...prompt..."
```

z.ai operates an Anthropic-API-compatible endpoint. Same trick works for any
provider with an Anthropic-compatible proxy (OpenRouter, anyscale, etc.).
Zero additional deps.

**(b) CCR (`@musistudio/claude-code-router@2.0.0`, MIT)**:

- Runs a local proxy server (`ccr start`)
- Config at `~/.claude-code-router/config.json` with `providers[]` array
- Intelligent routing across multiple providers in one session (e.g. route
  reasoning to GLM-4.6, coding to claude-sonnet-4-6)
- Activation: `eval "$(ccr activate)"` sets env vars pointing at the local proxy
- 12.1MB unpacked, no runtime deps

**Implication for executor schema:**

The locked `{router: 'ccr'}` flag was over-specified. Revised executor model:

```yaml
executors:
  - id: claude-glm-zai-direct
    agent: claude
    model: glm-4.6
    env:
      ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic
      ANTHROPIC_AUTH_TOKEN: ${ZAI_API_KEY}    # env interpolation by lib/executors

  - id: claude-multi-ccr
    agent: claude
    model: claude-sonnet-4-6
    router: ccr                                # invoke via `ccr activate` then spawn claude-agent-acp
```

POC ships with both: env-only for single-provider third-party (z.ai), CCR for
multi-provider intelligent routing. Most users will use env-only.

### ⚠ Cost finding (new, not in original spike scope)

Every cross-process resume **rebuilds the full prompt cache** — the resume in
M0.2 logged `cache_creation_input_tokens: 47368, cache_read_input_tokens: 0`
even though it ran ~10 seconds after the first call.

Anthropic's prompt cache TTL is 5 minutes by default (1 hour with `cache_control:
ephemeral_1h_input_tokens` which Claude Code does use). But `cache_read` was
still 0 — the cache is keyed by something that doesn't survive process boundary
(likely the running session's in-memory key handle, not just the conversation
content).

**Cost impact:**
- ~$0.28 per process spawn (cache_creation of ~45-50k tokens of system prompt + tools)
- Keep-alive (no respawn) costs $0 incremental — cache stays warm in the live process
- Checkpoint + respawn costs $0.28 per cycle

**Architectural implication — strengthens §1:**
- 30-min keep-alive window is not just UX comfort; it's **cost-saving**
- Each checkpoint+respawn cycle costs ~$0.28; aggressive checkpointing on
  short HITL waits would multiply cost
- For a slow HITL (user thinks for 25 min then answers): keep-alive saves $0.28
- For a stale HITL (user away for >30 min): checkpoint is correct — saves
  memory + idle compute, single $0.28 penalty on resume is acceptable

Consider exposing `MAISTER_KEEPALIVE_MINUTES` env var with default 30, allowing
ops to tune the cost/RAM trade-off.

## Net changes to docs

| Doc | Change |
|---|---|
| `CLAUDE.md` (root) §"Open questions" | Replace with "Findings from M0 spike — see `docs/.../m0-spike-findings-...`"; remove obsolete unknowns |
| `CLAUDE.md` (root) §5 | Add note: codex via `codex-acp` adapter (not raw `codex` binary) |
| `CLAUDE.md` (root) §"Stack" | Pin exact package versions in agent runtime row |
| `web/CLAUDE.md` "Not yet installed" | Replace placeholder `claude-code-acp` ref with verified `@agentclientprotocol/claude-agent-acp@0.37.0` |
| `.ai-factory/ROADMAP.md` M0 | Mark completed with date 2026-05-25; reference this findings doc |
| `.ai-factory/DESCRIPTION.md` Tech Stack | Same package pinning; add note about env-router vs CCR |
| `docs/kaa-maister-design-20260525-acp-revision.md` §"Unresolved → still open" | Move to "Unresolved → now resolved" with findings refs |

(All applied in the same commit as this findings doc.)

## Recommended next actions

1. **Pin packages in `supervisor/package.json`** when scaffolding (next coding session):
   - `@agentclientprotocol/claude-agent-acp@0.37.0`
   - `@agentclientprotocol/codex-acp@0.0.44`
   - `@agentclientprotocol/sdk@0.22.1`
2. **M1 (schema) can start** — no architectural blockers remain.
3. **Optional `openclaw/acpx` study** (MIT, TypeScript, multi-agent ACP CLI with session store at `~/.acpx/sessions/`) — patterns directly applicable to supervisor's session lifecycle. Not a dep, just a pattern reference.
4. **Cost telemetry from day 1** — record `cache_creation_input_tokens` per spawn into `cost.jsonl` to validate the 30-min keep-alive window empirically against real usage.

## Sources

- [@agentclientprotocol on GitHub](https://github.com/agentclientprotocol)
- [@agentclientprotocol/claude-agent-acp on npm](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)
- [@agentclientprotocol/codex-acp on npm](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)
- [Claude Code headless docs](https://code.claude.com/docs/en/headless)
- [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)
- [openclaw/acpx](https://github.com/openclaw/acpx)
- [How to Use Z.AI in Claude Code (claudelog)](https://claudelog.com/faqs/how-to-use-z-ai-in-claude-code/)
