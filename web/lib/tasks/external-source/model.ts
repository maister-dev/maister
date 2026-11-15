export type TaskSource = {
  kind: string;
  instance: string;
  scope: string;
  externalId: string;
  externalKey: string | null;
  url: string | null;
};

export type TaskSourceIdentity = Pick<
  TaskSource,
  "kind" | "instance" | "externalId"
>;

export type TaskSourceOrigin = "import" | "backfill" | "manual";

/** Display text for a binding: the human key when the provider has one. */
export function taskSourceDisplay(source: TaskSource): string {
  return source.externalKey ?? source.externalId;
}
