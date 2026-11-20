import "server-only";

import { MaisterError } from "@/lib/errors";

export const MAX_NOTE_CHARS = 262144;
export const MAX_VAULT_COMMAND_BYTES = 4 * 1024 * 1024;
export const MAX_PAGE_CHARS = 16384;
export const MAX_VAULT_NOTE_COUNT = 1024;
export const MAX_PAGE_ENTRIES = 100;

const setting = {
  injectionChars: [
    "MAISTER_AGENT_MEMORY_MAX_CHARS",
    32768,
    2048,
    MAX_NOTE_CHARS,
  ],
  noteChars: ["MAISTER_AGENT_MEMORY_NOTE_MAX_CHARS", 65536, 1, MAX_NOTE_CHARS],
  indexChars: ["MAISTER_AGENT_MEMORY_INDEX_MAX_CHARS", 8192, 1, 65536],
  vaultChars: ["MAISTER_AGENT_MEMORY_VAULT_MAX_CHARS", 1048576, 1, 16777216],
  notes: ["MAISTER_AGENT_MEMORY_MAX_NOTES", 256, 1, MAX_VAULT_NOTE_COUNT],
  pending: ["MAISTER_AGENT_MEMORY_MAX_PENDING", 256, 1, MAX_VAULT_NOTE_COUNT],
} as const;

export type AgentMemoryLimits = Readonly<Record<keyof typeof setting, number>>;

function readLimit(
  env: Readonly<Record<string, string | undefined>>,
  [name, defaultValue, min, max]: readonly [string, number, number, number],
): number {
  const raw = env[name];

  if (raw === undefined) return defaultValue;
  const value = Number(raw);

  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new MaisterError(
      "CONFIG",
      `${name} must be an integer between ${min} and ${max}`,
    );

  return value;
}

export function agentMemoryVaultLimits(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentMemoryLimits {
  const limits: AgentMemoryLimits = {
    injectionChars: readLimit(env, setting.injectionChars),
    noteChars: readLimit(env, setting.noteChars),
    indexChars: readLimit(env, setting.indexChars),
    vaultChars: readLimit(env, setting.vaultChars),
    notes: readLimit(env, setting.notes),
    pending: readLimit(env, setting.pending),
  };

  if (
    limits.indexChars > limits.noteChars ||
    limits.noteChars > limits.vaultChars ||
    limits.indexChars + 1024 > limits.injectionChars
  ) {
    throw new MaisterError(
      "CONFIG",
      "Memory index, note, vault and injection limits are incompatible",
    );
  }

  return limits;
}
