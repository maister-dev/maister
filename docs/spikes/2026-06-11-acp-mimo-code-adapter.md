# ACP MiMo Code Adapter Spike

## Summary

MiMo Code can be represented as a MAIster ACP adapter family, but it must start
as readiness-gated. The implementation adds adapter id `mimo` and launch command
`mimo acp`; it does not mark MiMo ready until the supervisor host has an
executable `mimo` binary and a cached ACP smoke result with `status="ok"`.

## Evidence

- MiMo Code CLI docs expose `mimo acp` with `--cwd`, `--port`, and `--hostname`.
- Public MiMo source declares package `@mimo-ai/cli` and binary `mimo`.
- The ACP command uses `AgentSideConnection` and `ndJsonStream`, sets
  `MIMOCODE_CLIENT=acp`, starts the internal server, and wires stdio JSON-RPC.
- The ACP implementation advertises `loadSession`, resume/list/fork session
  capabilities, MCP HTTP/SSE support, and prompt embedded-context/image support.
- MiMo currently depends on `@agentclientprotocol/sdk@0.16.1`; MAIster
  supervisor uses `@agentclientprotocol/sdk@0.22.1`.
- MiMo is OpenCode-derived and still exposes some OpenCode-branded auth text
  such as `opencode auth login`; MAIster must not alias the runner to OpenCode.
- Local prerequisite check: `mimo` is not on PATH in this worktree environment.

## Contract

| Field | MiMo V1 value |
| --- | --- |
| Adapter id | `mimo` |
| Capability agent | `mimo` |
| Provider kind | `agent_native` |
| Binary | `mimo` |
| Args | `acp` |
| Override env | `MAISTER_ADAPTER_BINARY_MIMO` |
| Model channel | `advisory` |
| Resume strategy | `session_resume_pending_smoke` |
| Client FS caps | `readTextFile=false`, `writeTextFile=false` |
| MCP transport | ACP `mcpServers` with `stdio | sse | http` |

## Smoke Matrix

- `mimo --version` or equivalent version probe returns without first-run
  writable-state failure.
- `mimo acp` starts over stdio in an isolated temporary cwd.
- ACP `initialize` accepts MAIster's explicit no-FS client capabilities.
- ACP `newSession` returns a session id.
- Permission request and response round-trip succeeds.
- Resume support is proven before checkpoint workflows are marked ready.
- Model switching remains advisory unless `unstable_setSessionModel` is
  proven for MiMo.

## Logging

Runtime logs must include structured fields:

- `adapter=mimo`
- `binary`
- `binarySource`
- `runnerId`
- `smoke.status`
- `protocolVersion`
- `authStatus`
- bounded `stderrTail` for failed probes

Logs must never include env values, auth tokens, raw provider config bodies, or
full ACP frames.

## Current Result

Implementation state is code-owned but readiness-gated:

- `command -v mimo` returned no executable in this worktree environment.
- `pnpm --filter @maister/supervisor smoke:acp mimo` returned:
  `{"adapter":"mimo","status":"skipped","reason":"binary not executable or not found on PATH: mimo","binary":"mimo"}`.
- Missing local binary yields diagnostics `available=false`.
- Missing smoke cache yields `smoke.status="pending"`.
- Runner readiness remains `NotReady` until both binary diagnostics and smoke
  are healthy.
