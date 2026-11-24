---
title: "Execution hosts"
description: "Configure an assigned supervisor, its MCP cache and the route back to Web."
---

An execution host is the supervisor boundary that owns ACP sessions, agent
processes, and execution workspaces. Web Core addresses execution through a
durable host and assignment contract instead of treating a URL or filesystem
path as ownership.

## Current topology

A default installation runs Web and one trusted supervisor on the same host.
Operators can also map a supervisor key to a private remote endpoint. Web
sends commands to the host recorded in the Run assignment. Each host needs
the workspace and repository storage required by the Runs it accepts.

The host contract already provides:

- durable host identity across supervisor restarts;
- monotonically increasing assignment epochs and stale-driver fencing;
- a durable command ledger and idempotent host receipts;
- opaque workspace handles on normal session operations;
- attributable sessions and node attempts;
- durable event replay across reconnects and restarts;
- runtime content addressed through opaque object references.

## Event delivery and lag

The supervisor persists events before delivery. Web accepts bounded batches and
acknowledges committed progress; interrupted delivery can replay safely. A slow
subscriber pauses and catches up from stored events when its connection can
drain again, rather than being disconnected simply for being slow.

Host-to-web delivery and processing into transcript, artifact, and usage views
can lag independently. Stream diagnostics distinguish measurable backlog from
unknown or stale data. A live connection alone does not prove that the displayed
Run state is current. Check both services' logs when progress stops.

## When the host pauses work

When Web falls behind on acknowledging events, the supervisor can pause event
producers and refuse new work. A prolonged pause can checkpoint an active
session so it can resume later. Retained, already acknowledged history is
different from undelivered backlog; a long conversation alone does not mean
Web is behind.

In **Settings → Execution host**, inspect the pressure state, duration, backlog,
and **Refusing new work** reason. The reason distinguishes storage, unacknowledged
backlog, retained backlog, and control reserve limits. Check Web ingestion,
Postgres availability, supervisor logs, and available storage before changing
capacity limits.

- A Flow node paused for host pressure shows the reason and defaults to
  **Resume as-is**. MAIster attempts automatic resume when the host admits work
  again, subject to capacity. You can still choose the offered stop or restart
  controls. Ordinary human decisions are not automatically answered this way.
- Platform-agent work can park for later continuation. New Flow and agent work
  waits while the host refuses admission.
- A scratch dialog shows a host-paused notice. Follow its send or recovery
  action after the host recovers; existing queued messages remain subject to
  [delivery and recovery rules](/guides/message-a-running-agent).
- A permission answer may remain saved with delivery pending. Retry that same
  answer when the host catches up; it has not necessarily reached the agent.

Do not delete runtime state to clear the condition. If the queue does not drain
or a Flow remains paused after recovery, retain the Run id, refusal reason,
host diagnostics, and Web/supervisor logs for investigation.

## Preserve state during upgrades

Back up Postgres, the supervisor's persistent state and runtime content, and
repository/worktree storage. Keeping only the worktree or the database does not
preserve the entire Run. Keep the host identity stable across service restarts;
do not clear supervisor state to repair a stalled stream. Use the reported
recovery action and retain diagnostics as described in
[Troubleshooting](/operations/troubleshooting).

## Route a Run to a remote supervisor

1. Give each supervisor a stable `MAISTER_EXECUTION_HOST_KEY` and its own persistent state. The Compose profile `remote-supervisor` reads `supervisor/.env`, keeps state and the MCP cache on a writable volume, and publishes port 7777 on loopback. Add shared repository, Git directory, worktree, local package and context paths as bind mounts in your Compose override. Use identical absolute paths on Web and the supervisor, grant UID/GID `1001:1001` the required access, and add workspace directories to `MAISTER_WORKSPACE_ROOTS`.
2. On Web, configure `MAISTER_EXECUTION_HOST_ENDPOINTS` as a JSON object mapping host keys to HTTPS origins, for example `{"design-b":"https://supervisor-b.internal"}`. Protect ingress with mutual TLS. Set `MAISTER_EXECUTION_HOST_TLS_CA_FILE`, `MAISTER_EXECUTION_HOST_TLS_CERT_FILE` and `MAISTER_EXECUTION_HOST_TLS_KEY_FILE` to the corresponding files on Web. A loopback endpoint may terminate an operator-managed authenticated tunnel.
3. After mounting those paths, set `MAISTER_EXECUTION_HOST_SHARED_WORKSPACE=1` and `MAISTER_EXECUTION_HOST_PREFERRED_KEY` on Web to send new default placements to the selected host. Leave the key unset for local placement. Initial private librarian turns use the local supervisor. Preserve the original supervisor state and workspace for interactive checkpoint resume.
4. On each remote supervisor, set `MAISTER_WORKLOAD_API_BASE_URL` to the Web API origin reachable from the workload. The built-in MAIster MCP uses this route for scoped operations such as asking a human. A locally assigned Run uses the local facade and `MAISTER_API_BASE_URL`.

## Prepare the selected MCP servers

HTTP MCP connections originate on the assigned workload. Check its DNS, egress and server-specific environment bindings. For npm/stdio, review the exact distribution in Studio and copy the descriptor SHA-256 from the preview to `MAISTER_MCP_ALLOWED_DIGESTS` on each eligible host. Keep `MAISTER_MCP_CACHE_DIR` on persistent, host-owned storage writable by the supervisor. The host validates the exact tarball and executable on first use and rechecks cached bytes and approval on reuse. A fresh host needs the registry connection for its first install.

If preparation fails, inspect the host key, assignment epoch, command ID and digest in the supervisor receipt. Check the configured source, supported runtime and host approval before retrying. Bind per-server secrets via `env:MAISTER_MCP_SECRET_<NAME>` on the selected MCP. See [package sources and versions](/guides/package-sources-and-versions) for the import and adoption workflow.
