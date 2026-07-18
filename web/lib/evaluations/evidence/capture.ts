import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { EvidenceItemInput } from "@/lib/evaluations/evidence/snapshots";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { sealEvidenceSnapshot, findReusableSnapshot } from "./snapshots";

import { getDb } from "@/lib/db/client";
import {
  evaluationExecutions,
  evaluationParticipants,
  evaluationStudies,
  runs,
  tasks,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { TERMINAL_RUN_STATUSES } from "@/lib/runs/run-status-sets";

const log = pino({
  name: "evaluations-evidence-capture",
  level: process.env.LOG_LEVEL ?? "info",
});

// Server cap on a captured per-participant diff (D9). A larger diff degrades to a
// bounded prefix flagged `truncated` — never an unbounded repository blob (a
// documented reference-protocol failure this contract corrects).
export const EVIDENCE_DIFF_MAX_BYTES = 512 * 1024;

const encoder = new TextEncoder();

// --- Redaction (pure) -------------------------------------------------------

export interface RedactionResult {
  text: string;
  redactions: number;
  kinds: string[];
}

// A conservative, recorded redaction pass over captured evidence text (D9). This
// is defense-in-depth over the already access-controlled store — never the sole
// boundary. It masks host absolute paths and secret-shaped tokens and RECORDS the
// count/kinds so coverage is honest ("redacted" is a first-class coverage class,
// not a silent edit).
export function redactEvidenceText(
  text: string,
  opts: { hostPaths?: string[] } = {},
): RedactionResult {
  let redactions = 0;
  const kinds = new Set<string>();
  let out = text;

  // 1. Explicit host paths passed by the caller (repo/worktree/parent roots) —
  //    literal, longest-first so a nested worktree path masks before its parent.
  const hostPaths = [...(opts.hostPaths ?? [])]
    .filter((p) => p && p.length > 1)
    .sort((a, b) => b.length - a.length);

  for (const hostPath of hostPaths) {
    const escaped = hostPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "g");

    out = out.replace(re, () => {
      redactions += 1;
      kinds.add("host_path");

      return "[REDACTED_PATH]";
    });
  }

  // 2. Generic host filesystem roots that could leak a private path even when the
  //    exact project root was not supplied.
  out = out.replace(
    /(?:\/Users\/[^\s"':)\]]+|\/home\/[^\s"':)\]]+|\/private\/(?:tmp|var)\/[^\s"':)\]]+|\/var\/folders\/[^\s"':)\]]+)/g,
    () => {
      redactions += 1;
      kinds.add("host_path");

      return "[REDACTED_PATH]";
    },
  );

  // 3. Secret-shaped tokens. Conservative, high-signal patterns only so real diff
  //    content is not mangled. Group-less patterns replace with the bare marker —
  //    on a pattern without a capture group, a positional replacer arg is the
  //    numeric match OFFSET, which must never be baked into sealed evidence.
  const bareSecretPatterns: Array<{ kind: string; re: RegExp }> = [
    { kind: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
    { kind: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
    { kind: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  ];

  for (const { kind, re } of bareSecretPatterns) {
    out = out.replace(re, () => {
      redactions += 1;
      kinds.add(kind);

      return "[REDACTED_SECRET]";
    });
  }

  // The one pattern WITH a capture group: the assignment prefix is preserved so
  // the redacted evidence still shows WHAT was assigned.
  out = out.replace(
    /((?:api[_-]?key|secret|token|password|passwd|authorization|bearer)["'\s:=]+)([A-Za-z0-9._\-]{16,})/gi,
    (_full: string, prefix: string) => {
      redactions += 1;
      kinds.add("assigned_secret");

      return `${prefix}[REDACTED_SECRET]`;
    },
  );

  return { text: out, redactions, kinds: [...kinds].sort() };
}

function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

// --- Git seam ---------------------------------------------------------------

// The resolved commit-anchored watermark for one participant Run. `tipSha` is a
// pinned commit SHA (NOT a live branch ref), so the diff read is reproducible and
// cannot drift after a later Run progresses (D5, D9).
export interface CaptureWatermark {
  baseCommit: string;
  tipSha: string;
  runStatus: string;
  // Host-only path used to read git objects; NEVER persisted in the watermark or
  // exposed in a DTO (kept off the public/participant record).
  repoPath: string;
}

export interface CaptureDiff {
  text: string;
  truncated: boolean;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
}

// The injectable capture git source (mirrors ObjectiveFactSource / JudgeSpawnFn):
// production reads git objects at the pinned SHA; tests inject a deterministic
// fake so coverage/redaction/reuse logic is verified without spawning git.
export interface CaptureGitSource {
  resolveWatermark(participant: {
    participantId: string;
    runId: string | null;
  }): Promise<CaptureWatermark | null>;
  readDiff(args: {
    repoPath: string;
    baseCommit: string;
    tipSha: string;
  }): Promise<CaptureDiff>;
}

// The production git source: commit-anchored reads (base..tipSha) against the
// project repo object DB — no live worktree scan (D9). An observed Run whose
// workspace/branch is gone resolves to null → an honest `unavailable` item.
export function defaultCaptureGitSource(db?: Db): CaptureGitSource {
  const d = db ?? getDb();

  return {
    async resolveWatermark({ runId }) {
      if (!runId) return null;

      const [ws] = await d
        .select({
          parentRepoPath: workspaces.parentRepoPath,
          branch: workspaces.branch,
          baseCommit: workspaces.baseCommit,
          baseBranch: workspaces.baseBranch,
          removedAt: workspaces.removedAt,
        })
        .from(workspaces)
        .where(eq(workspaces.runId, runId));

      if (!ws || ws.removedAt || !ws.parentRepoPath || !ws.branch) return null;

      const { localBranchHead, resolveBaseCommit } = await import(
        "@/lib/worktree"
      );
      const tipSha = await localBranchHead({
        projectRepoPath: ws.parentRepoPath,
        branch: ws.branch,
      });

      if (!tipSha) return null;

      let baseCommit = ws.baseCommit as string | null;

      if (!baseCommit && ws.baseBranch) {
        try {
          baseCommit = await resolveBaseCommit({
            projectRepoPath: ws.parentRepoPath,
            baseRef: ws.baseBranch,
          });
        } catch {
          baseCommit = null;
        }
      }
      if (!baseCommit) return null;

      const [run] = await d
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, runId));

      return {
        baseCommit,
        tipSha,
        runStatus: run?.status ?? "unknown",
        repoPath: ws.parentRepoPath,
      };
    },

    async readDiff({ repoPath, baseCommit, tipSha }) {
      const { diffRunWorkspace, diffRunWorkspaceFileMetadata } = await import(
        "@/lib/worktree"
      );
      // 2-dot base..tipSha reads the pinned commit tree, not the live worktree.
      const [diff, meta] = await Promise.all([
        diffRunWorkspace({
          projectRepoPath: repoPath,
          baseCommit,
          branch: tipSha,
        }),
        diffRunWorkspaceFileMetadata({
          projectRepoPath: repoPath,
          baseCommit,
          branch: tipSha,
        }).catch(() => []),
      ]);

      return {
        text: diff.text,
        truncated: diff.truncated,
        files: (meta as Array<Record<string, unknown>>).map((f) => ({
          path: String(f.path),
          status: String(f.status),
          additions: Number(f.additions ?? 0),
          deletions: Number(f.deletions ?? 0),
        })),
      };
    },
  };
}

// --- Capture ----------------------------------------------------------------

export interface CaptureResult {
  snapshotId: string;
  manifestDigest: string;
  reused: boolean;
  coverage: Record<string, number>;
  warnings: string[];
}

interface LiveParticipant {
  id: string;
  runId: string | null;
  label: string;
}

function capDiffBytes(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");

  if (bytes <= EVIDENCE_DIFF_MAX_BYTES) return { text, truncated: false };

  return {
    text: Buffer.from(text, "utf8")
      .subarray(0, EVIDENCE_DIFF_MAX_BYTES)
      .toString("utf8"),
    truncated: true,
  };
}

// Capture the immutable evidence snapshot for an execution (T2.3). Resolves each
// live participant's commit-anchored watermark, checks for a reusable sealed
// snapshot (identical participant watermark set + protocol digest, D5) BEFORE
// reading any diff, and otherwise reads/redacts/classifies each participant's diff
// and seals a new content-addressed snapshot. Byte payloads flow into the built
// seal/store core; this layer owns capture, coverage, and redaction.
export async function captureEvidenceForExecution(
  args: {
    executionId: string;
    evidenceProtocolDigest: string;
    preparedByUserId?: string | null;
  },
  deps?: { git?: CaptureGitSource },
  db?: Db,
): Promise<CaptureResult> {
  const d = db ?? getDb();
  const git = deps?.git ?? defaultCaptureGitSource(d);

  const [exec] = await d
    .select({
      id: evaluationExecutions.id,
      studyId: evaluationExecutions.studyId,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, args.executionId));

  if (!exec) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation execution not found: ${args.executionId}`,
    );
  }

  const [study] = await d
    .select({
      id: evaluationStudies.id,
      taskId: evaluationStudies.taskId,
    })
    .from(evaluationStudies)
    .where(eq(evaluationStudies.id, exec.studyId));

  const participants: LiveParticipant[] = await d
    .select({
      id: evaluationParticipants.id,
      runId: evaluationParticipants.runId,
      label: evaluationParticipants.label,
    })
    .from(evaluationParticipants)
    .where(
      and(
        eq(evaluationParticipants.studyId, exec.studyId),
        isNull(evaluationParticipants.removedAt),
      ),
    )
    .orderBy(evaluationParticipants.displayOrder);

  if (participants.length < 2) {
    throw new MaisterError(
      "PRECONDITION",
      `study ${exec.studyId} has fewer than 2 live participants; nothing to capture`,
    );
  }

  // Resolve every watermark FIRST (cheap) so a reusable snapshot short-circuits
  // the expensive diff reads (D5 — a compatible Method reuses identical evidence).
  const resolved = new Map<string, CaptureWatermark | null>();

  for (const p of participants) {
    resolved.set(
      p.id,
      await git.resolveWatermark({ participantId: p.id, runId: p.runId }),
    );
  }

  const participantWatermarks: Record<string, unknown> = {};

  for (const p of participants) {
    const w = resolved.get(p.id) ?? null;

    // The persisted watermark is bounded/opaque — NEVER the host repoPath (D3).
    participantWatermarks[p.id] = w
      ? {
          runId: p.runId,
          baseCommit: w.baseCommit,
          tipSha: w.tipSha,
          runStatus: w.runStatus,
        }
      : { runId: p.runId, unavailable: true };
  }

  const reusable = await findReusableSnapshot(
    {
      studyId: exec.studyId,
      evidenceProtocolDigest: args.evidenceProtocolDigest,
      participantWatermarks,
    },
    d,
  );

  if (reusable) {
    log.info(
      { executionId: args.executionId, snapshotId: reusable.id },
      "evidence reused for execution (identical watermarks)",
    );

    return {
      snapshotId: reusable.id,
      manifestDigest: reusable.manifestDigest ?? "",
      reused: true,
      coverage: {},
      warnings: [],
    };
  }

  const items: EvidenceItemInput[] = [];
  const coverage: Record<string, number> = {};
  const warnings: string[] = [];
  const bump = (cls: string) => {
    coverage[cls] = (coverage[cls] ?? 0) + 1;
  };

  // Shared ground-truth: the one task requirement every judge scores against
  // (the reference protocol's "one shared ground-truth boundary").
  if (study) {
    const [task] = await d
      .select({ title: tasks.title, prompt: tasks.prompt })
      .from(tasks)
      .where(eq(tasks.id, study.taskId));

    if (task) {
      const groundTruth = redactEvidenceText(
        `# ${task.title}\n\n${task.prompt ?? ""}`,
      );

      items.push({
        participantId: null,
        kind: "ground_truth",
        locator: `task:${study.taskId}`,
        coverageClass: groundTruth.redactions > 0 ? "redacted" : "captured",
        redaction:
          groundTruth.redactions > 0
            ? { count: groundTruth.redactions, kinds: groundTruth.kinds }
            : null,
        bytes: encoder.encode(groundTruth.text),
      });
      bump(groundTruth.redactions > 0 ? "redacted" : "captured");
    }
  }

  for (const p of participants) {
    const w = resolved.get(p.id) ?? null;

    if (!w) {
      items.push({
        participantId: p.id,
        kind: "diff",
        locator: `diff:${p.id}`,
        coverageClass: "unavailable",
        inclusionReason: "run link removed or workspace/branch unresolvable",
        bytes: encoder.encode(
          JSON.stringify({ unavailable: true, participant: p.label }),
        ),
      });
      bump("unavailable");
      warnings.push(`participant ${p.id}: evidence unavailable`);
      continue;
    }

    const raw = await git.readDiff({
      repoPath: w.repoPath,
      baseCommit: w.baseCommit,
      tipSha: w.tipSha,
    });
    const capped = capDiffBytes(raw.text);
    const truncated = capped.truncated || raw.truncated;
    const redacted = redactEvidenceText(capped.text, {
      hostPaths: [w.repoPath],
    });
    const coverageClass = truncated
      ? "truncated"
      : redacted.redactions > 0
        ? "redacted"
        : "captured";

    items.push({
      participantId: p.id,
      kind: "diff",
      locator: `diff:${p.id}`,
      coverageClass,
      sourceWatermark: w.tipSha,
      truncation: truncated
        ? { capBytes: EVIDENCE_DIFF_MAX_BYTES, rawTruncated: raw.truncated }
        : null,
      redaction:
        redacted.redactions > 0
          ? { count: redacted.redactions, kinds: redacted.kinds }
          : null,
      bytes: encoder.encode(redacted.text),
    });
    bump(coverageClass);

    items.push({
      participantId: p.id,
      kind: "file_summary",
      locator: `files:${p.id}`,
      coverageClass: "captured",
      sourceWatermark: w.tipSha,
      bytes: encoder.encode(JSON.stringify(raw.files)),
    });

    // An active (non-terminal) Run's dirty working tree is intentionally NOT
    // read — capture is commit-anchored. Record the explicit coverage class so
    // the asymmetry is a visible signal, never silent (D9).
    if (!isTerminalRunStatus(w.runStatus)) {
      items.push({
        participantId: p.id,
        kind: "working_tree",
        locator: `uncommitted:${p.id}`,
        coverageClass: "uncommitted_not_captured",
        inclusionReason: `Run is ${w.runStatus}; uncommitted changes past ${w.tipSha.slice(0, 8)} were not captured`,
        sourceWatermark: w.tipSha,
        bytes: encoder.encode(
          JSON.stringify({ uncommittedNotCaptured: true, tipSha: w.tipSha }),
        ),
      });
      bump("uncommitted_not_captured");
      warnings.push(
        `participant ${p.id}: active Run — uncommitted changes not captured`,
      );
    }
  }

  const sealed = await sealEvidenceSnapshot(
    {
      studyId: exec.studyId,
      participantWatermarks,
      evidenceProtocolDigest: args.evidenceProtocolDigest,
      items,
      preparedByUserId: args.preparedByUserId ?? null,
      coverageSummary: coverage,
      warnings,
    },
    d,
  );

  log.info(
    {
      executionId: args.executionId,
      snapshotId: sealed.snapshotId,
      coverage,
      warningCount: warnings.length,
    },
    "evidence captured and sealed",
  );

  return {
    snapshotId: sealed.snapshotId,
    manifestDigest: sealed.manifestDigest,
    reused: sealed.reused,
    coverage,
    warnings,
  };
}
