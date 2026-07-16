const TRAILER_KEYS = {
  runId: "Maister-Run-Id",
  task: "Maister-Task",
  flow: "Maister-Flow",
  node: "Maister-Node",
} as const;

type TrailerField = keyof typeof TRAILER_KEYS;

export type MaisterCommitProvenance = {
  runId: string;
  task?: string;
  flow?: string;
  node?: string;
};

export type WorktreeProvenanceWorkspaceKind = "flow" | "scratch" | "agent";

export type MaisterProvenance = MaisterCommitProvenance & {
  version?: 2;
  parentRepoPath?: string;
  projectId?: string;
  branch?: string;
  workspaceKind?: WorktreeProvenanceWorkspaceKind;
  createdAt?: string;
};

export type MaisterTrailers = Partial<MaisterProvenance>;

export class MaisterProvenanceError extends Error {
  override name = "MaisterProvenanceError";
}

function assertSafeValue(value: string, field: string): string {
  if (value.length === 0 || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new MaisterProvenanceError(
      `${field} must be a non-empty single-line value without NUL`,
    );
  }

  return value;
}

function assertSafeCommitMessage(message: string): string {
  if (message.length === 0 || message.includes("\0")) {
    throw new MaisterProvenanceError(
      "commit message must be non-empty without NUL",
    );
  }

  return message;
}

function keyForTrailerLine(line: string): TrailerField | null {
  return (
    (Object.entries(TRAILER_KEYS) as Array<[TrailerField, string]>).find(
      ([, key]) => line.startsWith(`${key}:`),
    )?.[0] ?? null
  );
}

function valueForTrailerLine(line: string, key: string): string {
  return assertSafeValue(line.slice(key.length + 1).trim(), key);
}

function expectedTrailers(
  metadata: MaisterCommitProvenance,
): Array<[TrailerField, string]> {
  const trailerValues: Array<[TrailerField, string | undefined]> = [
    ["runId", metadata.runId],
    ["task", metadata.task],
    ["flow", metadata.flow],
    ["node", metadata.node],
  ];

  return trailerValues
    .filter((entry): entry is [TrailerField, string] => entry[1] !== undefined)
    .map(([field, value]) => [
      field,
      assertSafeValue(value, TRAILER_KEYS[field]),
    ]);
}

export function parseMaisterTrailers(message: string): MaisterTrailers {
  assertSafeCommitMessage(message);
  const trailers: MaisterTrailers = {};

  for (const line of message.split(/\r?\n/)) {
    const field = keyForTrailerLine(line);

    if (!field) continue;

    const key = TRAILER_KEYS[field];
    const value = valueForTrailerLine(line, key);
    const existing = trailers[field];

    if (existing !== undefined) {
      if (existing !== value) {
        throw new MaisterProvenanceError(`conflicting ${key} trailers`);
      }

      throw new MaisterProvenanceError(`duplicate ${key} trailers`);
    }

    trailers[field] = value;
  }

  return trailers;
}

export function composeCommitMessage(
  message: string,
  metadata: MaisterCommitProvenance,
  existingTrailerLines: readonly string[] = [],
): string {
  const safeMessage = assertSafeCommitMessage(message);
  const expected = expectedTrailers(metadata);
  const existing = parseMaisterTrailers(
    [safeMessage, ...existingTrailerLines].join("\n"),
  );

  for (const [field, value] of expected) {
    if (existing[field] && existing[field] !== value) {
      throw new MaisterProvenanceError(
        `conflicting ${TRAILER_KEYS[field]} trailer`,
      );
    }
  }

  for (const field of ["task", "flow", "node"] as const) {
    if (metadata[field] === undefined && existing[field] !== undefined) {
      throw new MaisterProvenanceError(
        `unexpected ${TRAILER_KEYS[field]} trailer`,
      );
    }
  }

  const missing = expected
    .filter(([field]) => existing[field] === undefined)
    .map(([field, value]) => `${TRAILER_KEYS[field]}: ${value}`);

  if (missing.length === 0) return safeMessage;

  return `${safeMessage.trimEnd()}\n\n${missing.join("\n")}\n`;
}
