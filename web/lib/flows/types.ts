import "server-only";

import type { MaisterErrorCode } from "@/lib/errors";

export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | TemplateValue[]
  | { [k: string]: TemplateValue };

export type FlowContext = {
  task: {
    id: string;
    title: string;
    prompt: string;
    attemptNumber: number;
  };
  run: {
    id: string;
    attemptNumber: number;
    projectSlug: string;
  };
  executor: {
    id: string;
    agent: "claude" | "codex";
    model: string;
    router?: "ccr";
  };
  steps: Record<
    string,
    {
      output: string;
      vars: Record<string, unknown>;
      exitCode?: number;
    }
  >;
  env: Record<string, string>;
  // M12 (T3.4): artifact namespace keyed by artifactDefId. Current-wins
  // resolution: when multiple rows exist for the same id, the one with
  // validity='current' is preferred. Always present (default {}).
  artifacts: Record<
    string,
    {
      kind: string;
      uri?: string;
      validity: string;
      nodeId?: string;
    }
  >;
};

export type StepResult = {
  ok: boolean;
  stdout: string;
  stderr?: string;
  vars: Record<string, unknown>;
  exitCode?: number;
  errorCode?: MaisterErrorCode;
  durationMs?: number;
  acpSessionId?: string;
  needsInput?: boolean;
};

export type RunContext = {
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  worktreePath: string;
};

export type AcpSessionState = {
  currentSessionId: string | null;
  lastSeenMonotonicId: number;
  profileDigest?: string;
};

export type GuardKind = "pre" | "post" | "standalone";

export type GuardMetric = {
  guard: {
    cost?: number;
    time?: number;
    regex?: string;
  };
  observed: {
    durationMs: number;
    costTokens?: number;
    regexMatched?: boolean;
  };
  capExceeded: boolean;
  regexMatched?: boolean;
};
