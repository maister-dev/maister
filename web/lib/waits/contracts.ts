export const WAIT_ENGINE_MIN = "3.13.0";
export const PUBLICATION_ENGINE_MIN = "3.14.0";
export const MAX_WAIT_SECONDS = 31 * 24 * 60 * 60;
export const RESERVED_SIGNAL_OUTCOMES: readonly string[] = [
  "timeout",
  "stale",
  "cancelled",
];

export const WAIT_CONDITION_KINDS = [
  "timer",
  "comment",
  "run",
  "signal",
  "ci",
  "pr",
] as const;
export type WaitConditionKind = (typeof WAIT_CONDITION_KINDS)[number];

export const WAIT_STATES = [
  "reserved",
  "parking",
  "open",
  "resolved",
  "closed",
] as const;
export const WAIT_SOURCES = [
  "timer",
  "comment",
  "run",
  "signal",
  "operator",
  "head",
  "provider",
] as const;
export type WaitSource = (typeof WAIT_SOURCES)[number];

export type WaitJson =
  null | boolean | number | string | WaitJson[] | { [key: string]: WaitJson };

export type WaitSignal = {
  name: string;
  outcome: string;
  headSha?: string;
  payload?: WaitJson;
};

export type WaitConditionSnapshot = {
  schemaVersion: 1;
  kind: WaitConditionKind;
  outcomes: readonly string[];
  parameters: Record<string, WaitJson>;
};

export type WaitResult = {
  schemaVersion: 1;
  outcome: string;
  source: WaitSource;
  sourceId: string;
  resolvedAt: string;
  data?: WaitJson;
};
