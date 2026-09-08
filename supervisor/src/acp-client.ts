import type { EventEmitter } from "node:events";
import type {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";
import type { Logger } from "pino";

import { randomUUID } from "node:crypto";

import * as acp from "@agentclientprotocol/sdk";

import { boundedAcpStream, type BoundedAcpClient } from "./bounded-acp-stream";
import {
  clientCapabilitiesForAdapter,
  getAdapterRuntime,
  resolveResumeAction,
} from "./adapter-registry";
import { resolveContextMountDecision } from "./context-mounts";
import {
  classifyProgressUpdate,
  extractToolIdentity,
  HOOK_RULE_META,
  noProgressTick,
  repetitionTick,
  resolveCapabilityGuardDecision,
  resolvePathGuardDecision,
  toolCallSignature,
  WRITE_KINDS,
} from "./guardrail-hooks";
import { modelCatalogCache } from "./model-catalog/cache";
import { harvestSessionModels } from "./model-catalog/harvest";
import {
  pendingPermissions as defaultPendingPermissions,
  type AcpPermissionOutcome,
  type PendingPermissionRegistry,
} from "./pending-permissions";
import { SESSION_EVENT_CHANNEL } from "./registry";
import {
  isSupervisorError,
  SupervisorError,
  type ExecutorAgent,
  type HookDisposition,
  type HookRule,
  type McpServerInput,
  type PermissionOptionDescriptor,
  type RunnerLaunch,
  type SessionEvent,
  type SessionRecord,
} from "./types";

export type CreateAcpConnectionArgs = {
  stdin: NodeWritable;
  /** Object-mode captureAcpFrames output: one complete ACP frame per value. */
  stdoutSource: NodeReadable;
  sessionId: string;
  worktreePath: string;
  record: SessionRecord;
  emitter: EventEmitter;
  logger: Logger;
  adapter: ExecutorAgent;
  pendingPermissions?: PendingPermissionRegistry;
  mcpServers?: McpServerInput[];
  // When set, resume the prior ACP session via the `session/resume` call
  // (restores context, no history replay) instead of creating a `session/new`.
  resumeSessionId?: string;
  // The launched runner. Threaded for the ADR-076 passive harvest (the model
  // state on the session/new + session/resume response is fed into the shared
  // model-catalog cache) and reused by the model-application path (Phase 3).
  runner?: RunnerLaunch;
};

export type CreateAcpConnectionResult = {
  connection: acp.ClientSideConnection;
  acpSessionId: string;
};

type ToolCallLike = {
  toolCallId?: string;
  title?: string;
  kind?: string;
  // ADR-108 (M40): the standardized ACP write-path field — path_guard reads
  // locations[0].path; absent for kind-only-fallback adapters.
  locations?: Array<{ path?: string; line?: number }>;
};

// M30 (ADR-078 L2): decide whether a permission request raised during a
// read-only gate-chat turn is auto-rejected. Returns the reject option to
// deliver, or null to pass the request through to the normal HITL flow.
// Best-effort by design: no reject option / unknown kind / non-read-only
// turn → null (L3 guards). Exported for the supervisor test suite.
export function resolveReadOnlyAutoReject(
  readOnlyTurn: boolean | undefined,
  toolCall: ToolCallLike,
  options: ReadonlyArray<PermissionOptionDescriptor>,
): PermissionOptionDescriptor | null {
  if (readOnlyTurn !== true) return null;
  // The mutating-kind set is the ADR-108 WRITE_KINDS SSOT (`execute`/bash passes:
  // read-only commands must work; the web-side L3 sensor backstops what slips).
  if (!toolCall.kind || !WRITE_KINDS.has(toolCall.kind)) {
    return null;
  }

  return (
    options.find((o) => o.kind === "reject_once") ??
    options.find((o) => (o.kind ?? "").startsWith("reject")) ??
    null
  );
}

// M34 (ADR-090 L1): read-safe ACP toolCall kinds auto-approved on a
// read-only SESSION. Everything outside this allow-list — including
// `execute` (bash can mutate) and unknown kinds — is denied: the session is
// headless, so every request MUST be decided inline (there is no HITL inbox
// to fall through to).
const READ_ONLY_SESSION_ALLOWED_KINDS = new Set([
  "read",
  "search",
  "fetch",
  "think",
]);

export type ReadOnlySessionDecision =
  | { decision: "allow"; option: PermissionOptionDescriptor }
  | { decision: "deny"; option: PermissionOptionDescriptor | null }
  | null;

// Total arbitration for read-only sessions: allow read-safe kinds, deny the
// rest. A null return means the session is not read-only (normal HITL flow).
// A deny with a null option is answered with the `cancelled` outcome.
// Exported for the supervisor test suite.
export function resolveReadOnlySessionDecision(
  readOnlySession: boolean | undefined,
  toolCall: ToolCallLike,
  options: ReadonlyArray<PermissionOptionDescriptor>,
): ReadOnlySessionDecision {
  if (readOnlySession !== true) return null;

  const allow =
    toolCall.kind !== undefined &&
    READ_ONLY_SESSION_ALLOWED_KINDS.has(toolCall.kind);

  if (allow) {
    const option =
      options.find((o) => o.kind === "allow_once") ??
      options.find((o) => (o.kind ?? "").startsWith("allow")) ??
      null;

    // No allow-shaped option → fail closed.
    if (option) return { decision: "allow", option };
  }

  return {
    decision: "deny",
    option:
      options.find((o) => o.kind === "reject_once") ??
      options.find((o) => (o.kind ?? "").startsWith("reject")) ??
      null,
  };
}

// B1 (execution-policy permissions=auto_approve): pick the allow/proceed option
// for inline auto-approval (L3, below the read-only layers). Mirrors the L1
// allow-kind match; never selects a reject* option. Null when no allow-shaped
// option exists — the caller then falls through to HITL rather than
// blind-approve or cancel. Exported for the supervisor test suite.
export function resolveAutoApproveOption(
  options: ReadonlyArray<PermissionOptionDescriptor>,
): PermissionOptionDescriptor | null {
  return (
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => (o.kind ?? "").startsWith("allow")) ??
    null
  );
}

type AcpMethod = "initialize" | "newSession" | "resumeSession" | "prompt";

const ACP_HANDSHAKE_TIMEOUT_ENV = "MAISTER_ACP_HANDSHAKE_TIMEOUT_MS";

export const DEFAULT_ACP_HANDSHAKE_TIMEOUT_MS = 30_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveAcpHandshakeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[ACP_HANDSHAKE_TIMEOUT_ENV];

  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_ACP_HANDSHAKE_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    String(parsed) !== raw.trim()
  ) {
    throw new SupervisorError(
      "PRECONDITION",
      `${ACP_HANDSHAKE_TIMEOUT_ENV} must be a positive integer number of milliseconds`,
    );
  }

  return parsed;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${message} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function classifyAcpMethodError(args: {
  adapter: ExecutorAgent;
  method: AcpMethod;
  err: unknown;
  sessionId?: string;
}): SupervisorError {
  if (isSupervisorError(args.err)) return args.err;

  const rawMessage = errorText(args.err);
  const lower = rawMessage.toLowerCase();
  const context = `adapter=${args.adapter}, method=${args.method}${
    args.sessionId ? `, sessionId=${args.sessionId}` : ""
  }`;

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `ACP ${args.method} timed out while opening adapter session (${context}): ${rawMessage}`,
    );
  }

  if (
    lower.includes("auth") ||
    lower.includes("credential") ||
    lower.includes("login") ||
    lower.includes("api key") ||
    lower.includes("permission denied")
  ) {
    return new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `ACP ${args.method} failed because adapter authentication is unavailable (${context}): ${rawMessage}`,
    );
  }

  if (
    args.method === "resumeSession" &&
    (lower.includes("unsupported") ||
      lower.includes("not implemented") ||
      lower.includes("method not found") ||
      lower.includes("not found"))
  ) {
    return new SupervisorError(
      "CHECKPOINT",
      `ACP resume is unsupported (${context}): ${rawMessage}`,
    );
  }

  return new SupervisorError(
    "ACP_PROTOCOL",
    `ACP ${args.method} failed (${context}): ${rawMessage}`,
  );
}

async function callAcpMethod<T>(args: {
  adapter: ExecutorAgent;
  method: AcpMethod;
  sessionId?: string;
  logger: Logger;
  timeoutMs?: number;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    const promise = args.run();

    return await (args.timeoutMs
      ? withTimeout(
          promise,
          args.timeoutMs,
          `ACP ${args.method} (${args.adapter})`,
        )
      : promise);
  } catch (err) {
    const classified = classifyAcpMethodError({
      adapter: args.adapter,
      method: args.method,
      err,
      sessionId: args.sessionId,
    });

    args.logger.warn(
      {
        adapter: args.adapter,
        method: args.method,
        sessionId: args.sessionId,
        code: classified.code,
        err: classified.message,
      },
      "acp method failed",
    );

    throw classified;
  }
}

export async function createAcpConnection(
  args: CreateAcpConnectionArgs,
): Promise<CreateAcpConnectionResult> {
  const {
    stdin,
    stdoutSource,
    sessionId,
    worktreePath,
    record,
    emitter,
    logger,
  } = args;
  const pendingPermissions =
    args.pendingPermissions ?? defaultPendingPermissions;
  const handshakeTimeoutMs = resolveAcpHandshakeTimeoutMs();

  // ADR-108 (M40): emit a session.hook_trip stamped with the rule's frozen
  // lifecycle/disposition. The web tier escalates on `halt`; `deny` is
  // record-only there. `toolCall` is the pre_tool_call call (null for no_progress).
  // ADR-130: `capability_guard` is dual-disposition (per-call `deny`, Nth-deny
  // `halt`), so the caller may override the frozen `HOOK_RULE_META` disposition.
  const emitHookTrip = (
    rule: HookRule,
    toolCall: unknown,
    dispositionOverride?: HookDisposition,
  ): void => {
    record.monotonicId += 1;
    const meta = HOOK_RULE_META[rule];
    const event: SessionEvent = {
      type: "session.hook_trip",
      sessionId,
      monotonicId: record.monotonicId,
      rule,
      lifecycle: meta.lifecycle,
      disposition: dispositionOverride ?? meta.disposition,
      toolCall,
    };

    emitter.emit(SESSION_EVENT_CHANNEL, event);
  };

  const clientImpl: BoundedAcpClient = {
    async sessionUpdate(params) {
      record.monotonicId += 1;
      const event: SessionEvent = {
        type: "session.update",
        sessionId,
        monotonicId: record.monotonicId,
        update: params.update,
      };

      emitter.emit(SESSION_EVENT_CHANNEL, event);
      logger.debug(
        {
          sessionId,
          monotonicId: record.monotonicId,
          updateType:
            (params.update as { sessionUpdate?: string } | null)
              ?.sessionUpdate ?? null,
        },
        "session-update",
      );

      // ADR-108 (M40): no_progress watchdog (post_turn; cannot block — the tool
      // already ran). Count tool-call turns, reset on a write-kind (diff-producing)
      // call, halt at >= maxTurns. On halt, cancel any in-flight permission
      // deferred and stop; the web tier owns the escalate (the supervisor never
      // self-kills).
      if (record.hooksConfig?.noProgress && !record.hookHalted) {
        const { isTurn, isProgress } = classifyProgressUpdate(params.update);

        if (isTurn) {
          const tick = noProgressTick(
            { turnsSinceProgress: record.turnsSinceProgress ?? 0 },
            isProgress,
            record.hooksConfig.noProgress.maxTurns,
          );

          record.turnsSinceProgress = tick.turnsSinceProgress;

          if (tick.tripped) {
            record.hookHalted = true;
            emitHookTrip("no_progress", null);

            for (const requestId of pendingPermissions.requestIds(sessionId)) {
              pendingPermissions.cancel(
                sessionId,
                requestId,
                "hook_trip:no_progress",
              );
            }

            logger.info(
              {
                sessionId,
                turnsSinceProgress: tick.turnsSinceProgress,
                maxTurns: record.hooksConfig.noProgress.maxTurns,
              },
              "[guardrail] no_progress halt",
            );
          }
        }
      }

      // ADR-130 D5: always-ask sentinel. A WRITE that EXECUTES without ever
      // reaching the always-ask seam (requestPermission) means the adapter stopped
      // honoring always-ask → fail-closed halt. The claude adapter STREAMS the
      // pending `tool_call` BEFORE it calls requestPermission (canUseTool runs
      // after the assistant message completes), so a write's id is announced here
      // first, removed from the pending set when it reaches requestPermission
      // (arbitration), and only halts if it is STILL pending when its execution
      // `tool_call_update` (status completed|failed) arrives. Keying off the
      // pending notification instead would false-halt every legitimate write.
      if (record.enforcementProfile && !record.hookHalted) {
        const u = params.update as {
          sessionUpdate?: string;
          kind?: string;
          status?: string;
          toolCallId?: string;
        } | null;
        const id = typeof u?.toolCallId === "string" ? u.toolCallId : null;

        if (
          u?.sessionUpdate === "tool_call" &&
          typeof u.kind === "string" &&
          WRITE_KINDS.has(u.kind) &&
          id
        ) {
          // Streaming announcement of a write — track until it reaches the seam
          // (requestPermission removes it) or executes (below). WRITE_KINDS-only by
          // design: `execute`/bash is NOT tracked here (it can be read-only, like
          // path_guard) — a mid-session bash bypass is not caught by this sentinel.
          // Bash is covered by the primary path instead: the capabilityEnforcement
          // smoke proves it reaches requestPermission before an adapter is admitted
          // (ADR-130, M3).
          record.capabilityPendingWriteIds?.add(id);
        } else if (
          u?.sessionUpdate === "tool_call_update" &&
          (u.status === "completed" || u.status === "failed") &&
          id &&
          record.capabilityPendingWriteIds?.delete(id)
        ) {
          // A tracked write executed while still un-arbitrated → never reached the
          // seam. Fail-closed halt.
          record.hookHalted = true;
          emitHookTrip("capability_guard", params.update, "halt");

          for (const requestId of pendingPermissions.requestIds(sessionId)) {
            pendingPermissions.cancel(
              sessionId,
              requestId,
              "hook_trip:capability_guard",
            );
          }

          logger.warn(
            { sessionId, toolCallId: id },
            "[guardrail] capability_guard always-ask sentinel halt (write executed without reaching the seam)",
          );
        }
      }
    },

    async requestPermission(params, onPrepared?: () => void) {
      try {
        const tc = (params.toolCall ?? {}) as ToolCallLike;
        const requestId = randomUUID();
        const options: ReadonlyArray<PermissionOptionDescriptor> =
          params.options.map((o) => ({
            optionId: o.optionId,
            kind: o.kind,
            name: o.name,
          }));

        // M34 (ADR-090 L1): a read-only SESSION arbitrates every request
        // inline — read-safe kinds approved, everything else denied (the
        // session is headless; no HITL inbox exists for it). Decided BEFORE
        // the SSE emit and the pending-permission registration.
        const sessionDecision = resolveReadOnlySessionDecision(
          record.readOnlySession,
          tc,
          options,
        );

        if (sessionDecision) {
          logger.info(
            {
              sessionId,
              toolKind: tc.kind,
              decision: sessionDecision.decision,
              optionId: sessionDecision.option?.optionId ?? null,
            },
            "[read-only-session] permission arbitrated inline (L1)",
          );

          if (sessionDecision.option) {
            return {
              outcome: {
                outcome: "selected",
                optionId: sessionDecision.option.optionId,
              },
            };
          }

          return { outcome: { outcome: "cancelled" } };
        }

        // M30 (ADR-078 L2): a mutating tool on a read-only gate-chat turn is
        // auto-rejected BEFORE the SSE emit and the pending-permission
        // registration — no session.permission_request event fires and no web
        // hitl row is created. No-op under permissive runner policies
        // (--dangerously-skip-permissions never calls this) — hence L3.
        const autoReject = resolveReadOnlyAutoReject(
          record.readOnlyTurn,
          tc,
          options,
        );

        if (autoReject) {
          logger.info(
            {
              sessionId,
              toolKind: tc.kind,
              optionId: autoReject.optionId,
            },
            "[neutrality] read-only turn — mutating tool auto-rejected (L2)",
          );

          return {
            outcome: { outcome: "selected", optionId: autoReject.optionId },
          };
        }

        // ADR-108 (M40): the universal guardrail interceptor — runs after the
        // read-only layers (L1/L2) and BEFORE B1 auto-approve, so a deny/halt
        // resolves before the tool runs AND cannot be bypassed by auto-approve.
        // (Every `unattended` run is permissions=auto_approve — the exact runs the
        // two-tier default arms guardrails for; placing this after B1 would silently
        // no-op path_guard + repetition on them. See ADR-108 / SDD §5.) No-op when
        // the session carries no hooksConfig (byte-identical to a pre-hook run).
        if (record.hooksConfig) {
          // A prior repetition/no_progress halt fired → cancel every further tool
          // call until the web tier checkpoints (the supervisor never self-kills).
          if (record.hookHalted) {
            return { outcome: { outcome: "cancelled" } };
          }

          // Rule 1 — repetition (halt): N consecutive identical tool-call
          // signatures. Runs BEFORE path_guard so a denied (out-of-lane) write
          // still feeds the breaker — path_guard is deny-and-continue and makes no
          // progress on its own, so a repeated denied write would otherwise loop
          // forever (the original interceptor returned cancelled before this tick).
          if (record.hooksConfig.repetition) {
            const sig = toolCallSignature(params.toolCall);
            const tick = repetitionTick(
              {
                lastToolCallSig: record.lastToolCallSig,
                repeatCount: record.repeatCount ?? 0,
              },
              sig,
              record.hooksConfig.repetition.max,
            );

            record.lastToolCallSig = tick.lastToolCallSig;
            record.repeatCount = tick.repeatCount;

            if (tick.tripped) {
              record.hookHalted = true;
              emitHookTrip("repetition", params.toolCall);
              logger.info(
                {
                  sessionId,
                  toolKind: tc.kind,
                  repeatCount: tick.repeatCount,
                  max: record.hooksConfig.repetition.max,
                },
                "[guardrail] repetition halt",
              );

              return { outcome: { outcome: "cancelled" } };
            }
          }

          // Rule 2 — path_guard (deny-and-continue): a write outside the lane is
          // denied inline; the run continues. Repeated denials are caught by the
          // liveness breakers — repetition (above) for identical writes, no_progress
          // (below, in this branch) for varied ones.
          const pathDecision = resolvePathGuardDecision({
            pathGuard: record.hooksConfig.pathGuard,
            toolCall: tc,
            worktreePath,
          });

          if (pathDecision?.decision === "deny") {
            if (
              pathDecision.reason === "kind_only_fallback" &&
              !record.hookFallbackWarned
            ) {
              record.hookFallbackWarned = true;
              logger.warn(
                { sessionId, toolKind: tc.kind, adapter: args.adapter },
                "[guardrail] path_guard kind-only fallback — adapter omits toolCall.locations; write-kind calls denied",
              );
            }

            // A denied write makes no progress and (for a permission-only call)
            // fires no session.update turn, so the post_turn no_progress watchdog
            // never sees it. Count it here as a non-progress turn so a stream of
            // denied writes — including VARIED ones repetition cannot match — trips
            // no_progress instead of looping forever.
            if (record.hooksConfig.noProgress) {
              const tick = noProgressTick(
                { turnsSinceProgress: record.turnsSinceProgress ?? 0 },
                false,
                record.hooksConfig.noProgress.maxTurns,
              );

              record.turnsSinceProgress = tick.turnsSinceProgress;

              if (tick.tripped) {
                record.hookHalted = true;
                emitHookTrip("no_progress", null);

                for (const requestId of pendingPermissions.requestIds(
                  sessionId,
                )) {
                  pendingPermissions.cancel(
                    sessionId,
                    requestId,
                    "hook_trip:no_progress",
                  );
                }

                logger.info(
                  {
                    sessionId,
                    toolKind: tc.kind,
                    turnsSinceProgress: tick.turnsSinceProgress,
                    maxTurns: record.hooksConfig.noProgress.maxTurns,
                  },
                  "[guardrail] no_progress halt (denied write)",
                );

                return { outcome: { outcome: "cancelled" } };
              }
            }

            emitHookTrip("path_guard", params.toolCall);
            logger.info(
              { sessionId, toolKind: tc.kind, reason: pathDecision.reason },
              "[guardrail] path_guard deny (run continues)",
            );

            return { outcome: { outcome: "cancelled" } };
          }
        }

        // ADR-157 (L2): read-only sibling-repo context mounts. UNCONDITIONAL
        // whenever the session declares mounts — deliberately NOT opt-in through
        // settings.hooks, because the read-only contract is the mount's whole
        // point. Placed AFTER the M40 interceptor so a denied write still feeds the
        // repetition / no_progress liveness breakers, and BEFORE capability_guard +
        // B1 so auto-approve can never bypass it. Deny shape mirrors path_guard:
        // the tool call is cancelled and the run continues.
        if (record.contextMounts && record.contextMounts.length > 0) {
          const mountDecision = await resolveContextMountDecision({
            mounts: record.contextMounts,
            toolCall: tc,
          });

          if (mountDecision.decision === "deny") {
            logger.warn(
              {
                sessionId,
                toolKind: tc.kind,
                mountSlug: mountDecision.mount.slug,
                mountPath: mountDecision.mount.path,
                path: mountDecision.path,
              },
              "[context-mount] write denied — sibling-repo mount is read-only (L2)",
            );

            return { outcome: { outcome: "cancelled" } };
          }

          if (
            mountDecision.decision === "unverifiable" &&
            !record.contextMountFallbackWarned
          ) {
            record.contextMountFallbackWarned = true;
            logger.warn(
              { sessionId, toolKind: tc.kind, adapter: args.adapter },
              "[context-mount] adapter omits toolCall.locations — write-class calls cannot be matched against mount roots (L3 dirty check backstops)",
            );
          }
        }

        // ADR-130: capability_guard — enforce strict tools/mcps by tool identity.
        // Runs AFTER path_guard and BEFORE B1 so an out-of-profile call is denied even
        // on unattended/auto-approve sessions. Armed only when the session carries a
        // derived enforcementProfile. In-profile → auto-allow inline (zero HITL);
        // out-of-profile → deny-and-continue; Nth consecutive deny → halt.
        if (record.enforcementProfile) {
          // A prior halt (capability_guard or M40) fired → cancel every further call
          // (mirrors the M40 hooksConfig hookHalted short-circuit, for a session that
          // carries an enforcementProfile but no hooksConfig).
          if (record.hookHalted) {
            return { outcome: { outcome: "cancelled" } };
          }

          // D5 sentinel bookkeeping: this call reached the always-ask seam, so it
          // is no longer an un-arbitrated pending write (clears any streamed id).
          if (tc.toolCallId) {
            record.capabilityPendingWriteIds?.delete(tc.toolCallId);
          }

          let decision;

          try {
            decision = resolveCapabilityGuardDecision(
              record.enforcementProfile,
              tc,
            );
          } catch (err) {
            // Deferred-release invariant: a throw in evaluation falls through to a
            // logged deny (never an unresolved RPC).
            logger.warn(
              {
                sessionId,
                err: err instanceof Error ? err.message : String(err),
              },
              "[guardrail] capability_guard evaluation threw — deny (fail-closed)",
            );
            decision = {
              decision: "deny" as const,
              reason: "capability_guard: evaluation error (fail-closed)",
              governedClass: "tools" as const,
            };
          }

          if (decision.decision === "deny") {
            const identity = extractToolIdentity(tc);

            record.capabilityDenyCount = (record.capabilityDenyCount ?? 0) + 1;

            // Nth consecutive out-of-profile deny → halt (mirror no_progress): cancel
            // every pending deferred, reset the counter, emit an explicit `halt`.
            if (
              record.capabilityDenyCount >=
              record.enforcementProfile.escalationThreshold
            ) {
              record.hookHalted = true;
              record.capabilityDenyCount = 0;
              emitHookTrip("capability_guard", params.toolCall, "halt");

              for (const requestId of pendingPermissions.requestIds(
                sessionId,
              )) {
                pendingPermissions.cancel(
                  sessionId,
                  requestId,
                  "hook_trip:capability_guard",
                );
              }

              logger.info(
                {
                  sessionId,
                  toolIdentity: identity.name,
                  governedClass: decision.governedClass,
                  threshold: record.enforcementProfile.escalationThreshold,
                },
                "[guardrail] capability_guard halt (Nth consecutive deny)",
              );

              return { outcome: { outcome: "cancelled" } };
            }

            emitHookTrip("capability_guard", params.toolCall, "deny");
            logger.debug(
              {
                sessionId,
                toolIdentity: identity.name,
                kind: tc.kind,
                governedClass: decision.governedClass,
                decision: "deny",
                reason: decision.reason,
                denyCount: record.capabilityDenyCount,
              },
              "[guardrail] capability_guard deny (run continues)",
            );

            return { outcome: { outcome: "cancelled" } };
          }

          if (decision.decision === "allow") {
            // In-profile → the supervisor is the permission authority: auto-allow
            // inline (zero added HITL) and reset the consecutive-deny counter.
            record.capabilityDenyCount = 0;

            const allowOption = resolveAutoApproveOption(options);

            if (allowOption) {
              logger.debug(
                { sessionId, toolIdentity: extractToolIdentity(tc).name },
                "[guardrail] capability_guard allow (in-profile)",
              );

              return {
                outcome: {
                  outcome: "selected",
                  optionId: allowOption.optionId,
                },
              };
            }
            // No allow-shaped option → fall through to HITL (defensive).
          }
          // pass_through (no strict class governs this call) → fall through unchanged.
        }

        // B1 (execution-policy permissions=auto_approve, L3): a session launched
        // with autoApprovePermissions auto-selects the allow option inline — BELOW
        // the read-only layers AND the guardrail interceptor (L1 / L2 / guardrails
        // always win above). No allow-shaped option → fall through to the HITL
        // deferred (never blind-approve or cancel).
        if (record.autoApprovePermissions === true) {
          const autoApprove = resolveAutoApproveOption(options);

          if (autoApprove) {
            logger.info(
              { sessionId, toolKind: tc.kind, optionId: autoApprove.optionId },
              "[perm.auto] permission auto-approved (L3)",
            );

            return {
              outcome: { outcome: "selected", optionId: autoApprove.optionId },
            };
          }
        }

        record.monotonicId += 1;
        const event: SessionEvent = {
          type: "session.permission_request",
          sessionId,
          monotonicId: record.monotonicId,
          requestId,
          options,
          toolCall: params.toolCall,
        };

        emitter.emit(SESSION_EVENT_CHANNEL, event);
        logger.info(
          {
            sessionId,
            requestId,
            optionsCount: options.length,
            toolCallSummary: {
              id: tc.toolCallId,
              kind: tc.kind,
              title: tc.title,
            },
          },
          "permission-request emitted",
        );

        return new Promise<AcpPermissionOutcome>((resolve, reject) => {
          pendingPermissions.register(sessionId, requestId, {
            resolve,
            reject,
          });
        }).then((outcome) => ({ outcome }));
      } finally {
        onPrepared?.();
      }
    },
  };

  const stream = boundedAcpStream({
    source: stdoutSource,
    stdin,
    client: clientImpl,
    onFailure(error) {
      record.abortOutput?.(error);
      record.outputFailure = {
        code: error.code,
        message: error.message,
        details: error.details,
      };
      logger.error(
        {
          sessionId,
          commandId: record.activePromptCommandId,
          reason: error.details?.reason,
        },
        "producer-acp-failed",
      );
      stdoutSource.destroy(error);
      stdin.destroy();
    },
  });
  const connection = new acp.ClientSideConnection(() => clientImpl, stream);

  logger.info({ sessionId }, "acp connection-init");

  const initResp = await callAcpMethod({
    adapter: args.adapter,
    method: "initialize",
    sessionId,
    logger,
    timeoutMs: handshakeTimeoutMs,
    run: () =>
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: clientCapabilitiesForAdapter(args.adapter),
      }),
  });

  logger.info(
    {
      sessionId,
      adapter: args.adapter,
      protocolVersion: initResp.protocolVersion,
    },
    "acp initialized",
  );

  // M27/T-C4: build the transport-appropriate ACP McpServer. Secret VALUES are
  // resolved here, supervisor-side, from process.env by NAME — never received
  // from the web tier (envKeys/headerKeys carry NAMES only).
  const acpMcpServers: acp.McpServer[] = (args.mcpServers ?? []).map((s) => {
    if (s.transport === "sse" || s.transport === "http") {
      return {
        type: s.transport,
        name: s.name,
        url: s.url ?? "",
        headers: (s.headerKeys ?? []).map((k) => ({
          name: k,
          value: process.env[k] ?? "",
        })),
      };
    }

    return {
      name: s.name,
      command: s.command ?? "",
      args: s.args ?? [],
      // Literal `env` entries (server-generated secrets, M34) win over
      // same-named process.env lookups.
      env: [
        ...(s.envKeys ?? [])
          .filter((k) => !(k in (s.env ?? {})))
          .map((k) => ({ name: k, value: process.env[k] ?? "" })),
        ...Object.entries(s.env ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      ],
    };
  });

  // Resume uses the ACP `session/resume` call: it restores the prior
  // conversation into the agent's context WITHOUT replaying history (ACP spec:
  // "the Agent MUST NOT replay the conversation history") — which is exactly
  // what we want, the transcript is already persisted. The session id is
  // REUSED, never minted anew, so runs.acp_session_id keeps pointing at the
  // real conversation. (Resume is a protocol call, NOT a CLI flag: both
  // adapters ignore `--resume` on argv.)
  if (args.resumeSessionId) {
    const resumeSessionId = args.resumeSessionId;
    const agentCaps = (initResp.agentCapabilities ?? {}) as {
      sessionCapabilities?: { load?: unknown; resume?: unknown };
    };
    const resumeAction = resolveResumeAction(args.adapter, agentCaps);

    if (resumeAction.kind === "resume_session") {
      const resumeResp = await callAcpMethod({
        adapter: args.adapter,
        method: "resumeSession",
        sessionId,
        logger,
        timeoutMs: handshakeTimeoutMs,
        run: () =>
          connection.resumeSession({
            sessionId: resumeSessionId,
            cwd: worktreePath,
            mcpServers: acpMcpServers as acp.McpServer[],
          }),
      });

      logger.info(
        { sessionId, acpSessionId: resumeSessionId },
        "acp resume-session",
      );
      record.acpSessionId = resumeSessionId;
      harvestSessionModels(
        args.runner,
        resumeResp.models,
        modelCatalogCache,
        logger,
      );
      await applyAndVerifyModel({
        connection,
        runner: args.runner,
        models: resumeResp.models,
        acpSessionId: resumeSessionId,
        sessionId,
        record,
        emitter,
        logger,
      });

      return { connection, acpSessionId: resumeSessionId };
    }
    // Unreachable for the bundled claude/codex adapters (both advertise
    // sessionCapabilities.resume). FAIL LOUD rather than silently falling
    // through to newSession — an empty session would orphan the conversation
    // (the original resume bug). Surfaces as the documented terminal CHECKPOINT.
    throw new SupervisorError(
      "CHECKPOINT",
      `${resumeAction.reason} (acpSessionId=${resumeSessionId})`,
    );
  }

  const newSessionResp = await callAcpMethod({
    adapter: args.adapter,
    method: "newSession",
    sessionId,
    logger,
    timeoutMs: handshakeTimeoutMs,
    run: () =>
      connection.newSession({
        cwd: worktreePath,
        mcpServers: acpMcpServers as acp.McpServer[],
      }),
  });

  logger.info(
    { sessionId, acpSessionId: newSessionResp.sessionId },
    "acp new-session",
  );

  record.acpSessionId = newSessionResp.sessionId;
  harvestSessionModels(
    args.runner,
    newSessionResp.models,
    modelCatalogCache,
    logger,
  );
  await applyAndVerifyModel({
    connection,
    runner: args.runner,
    models: newSessionResp.models,
    acpSessionId: newSessionResp.sessionId,
    sessionId,
    record,
    emitter,
    logger,
  });

  return { connection, acpSessionId: newSessionResp.sessionId };
}

type ApplyModelArgs = {
  connection: acp.ClientSideConnection;
  runner: RunnerLaunch | undefined;
  models: acp.SessionModelState | null | undefined;
  acpSessionId: string;
  sessionId: string;
  record: SessionRecord;
  emitter: EventEmitter;
  logger: Logger;
};

// ADR-076 model application + verification (T3.2/T3.3). claude is pinned ahead
// of session/new via the settings.local.json channel (web tier), so here we
// only verify it. codex is pinned via the ACP `unstable_setSessionModel` call.
// A residual mismatch is emitted as an ADVISORY `session.update` (a synthetic
// payload variant, NOT a new event kind) and NEVER fails the run — env-router
// slot-mapping legitimately reports a remapped name, and canonical
// `usage.recorded` events stay the billed-model ground truth. Runs on both new
// and resumed sessions.
export async function applyAndVerifyModel(args: ApplyModelArgs): Promise<void> {
  const {
    connection,
    runner,
    models,
    acpSessionId,
    sessionId,
    record,
    emitter,
    logger,
  } = args;
  const observed = models?.currentModelId;

  // `!runner` narrows `runner` to non-undefined for the accesses below;
  // `!runner.model` is defensive (the schema enforces min(1)).
  if (!runner || !runner.model) return;

  const configured = runner.model;
  const channel = getAdapterRuntime(runner.adapter).modelChannel;

  // Already on the configured model → nothing to apply or verify (only decidable
  // when the adapter actually reported a current model).
  if (observed === configured) return;

  // claude pins via settings.local.json before session/new, so this path only
  // VERIFIES. With no observed model there is nothing to verify — return rather
  // than emit an advisory we cannot substantiate. codex pins HERE via
  // setSessionModel, so it must NOT bail on absent observed: a version-skewed
  // adapter that omits currentModelId still needs the configured model applied
  // (ADR-076 apply-gap).
  if (channel === "settings_local" && !observed) return;

  if (channel === "set_session_model") {
    try {
      await connection.unstable_setSessionModel({
        sessionId: acpSessionId,
        modelId: configured,
      });
      logger.info(
        { sessionId, configuredModel: configured, observedModelId: observed },
        "model applied via setSessionModel",
      );

      return;
    } catch (err) {
      logger.warn(
        {
          sessionId,
          configuredModel: configured,
          err: err instanceof Error ? err.message : String(err),
        },
        "setSessionModel failed; emitting advisory",
      );
    }
  }

  record.monotonicId += 1;
  emitter.emit(SESSION_EVENT_CHANNEL, {
    type: "session.update",
    sessionId,
    monotonicId: record.monotonicId,
    update: {
      sessionUpdate: "model_advisory",
      configuredModel: configured,
      // "" when the adapter reported no current model (codex apply failed with
      // no observable state); the asyncapi contract requires the field present.
      observedModelId: observed ?? "",
      channel,
    },
  } satisfies SessionEvent);
  logger.info(
    {
      sessionId,
      configuredModel: configured,
      observedModelId: observed,
      channel,
    },
    "model mismatch advisory",
  );
}

export async function sendPromptOnConnection(
  conn: acp.ClientSideConnection,
  args: {
    adapter: ExecutorAgent;
    acpSessionId: string;
    stepId: string;
    prompt: string;
    contentBlocks?: acp.ContentBlock[];
    // ADR-157: rendered read-only context-mount preamble, PREPENDED as its own
    // text block (the caller decides when — once per session). Absent → the
    // prompt is byte-identical to a mount-less run.
    preamble?: string;
    // Interrupt: when the turn ends with the `cancelled` stop reason and this
    // returns true, the cancel was operator-requested (session/cancel) — the
    // response is returned verbatim instead of throwing. A `cancelled` reason
    // WITHOUT this (hook halt, unexpected abort) still throws ACP_PROTOCOL so
    // the flow/agent path marks the run crashed as before.
    isUserCancel?: () => boolean;
  },
  logger: Logger,
): Promise<acp.PromptResponse> {
  // T5.4: forward the web tier's assembled content blocks verbatim; otherwise
  // wrap the plain string into a single text block (verbatim-forward).
  const body: acp.ContentBlock[] =
    args.contentBlocks && args.contentBlocks.length > 0
      ? args.contentBlocks
      : [{ type: "text", text: args.prompt }];
  // ADR-157: the mount preamble is a PREPENDED block of its own — the caller's
  // blocks are still forwarded verbatim, never rewritten.
  const prompt: acp.ContentBlock[] = args.preamble
    ? [{ type: "text", text: args.preamble }, ...body]
    : body;

  logger.info(
    {
      acpSessionId: args.acpSessionId,
      stepId: args.stepId,
      len: args.prompt.length,
      blocks: prompt.length,
    },
    "acp prompt-sent",
  );

  const resp = await callAcpMethod({
    adapter: args.adapter,
    method: "prompt",
    sessionId: args.acpSessionId,
    logger,
    run: () =>
      conn.prompt({
        sessionId: args.acpSessionId,
        prompt,
      }),
  });

  logger.info(
    {
      acpSessionId: args.acpSessionId,
      stepId: args.stepId,
      stopReason: resp.stopReason,
    },
    "acp prompt-end",
  );

  if (resp.stopReason === "cancelled" && !args.isUserCancel?.()) {
    throw new SupervisorError(
      "ACP_PROTOCOL",
      `prompt cancelled (sessionId=${args.acpSessionId}, stepId=${args.stepId})`,
    );
  }

  return resp;
}
